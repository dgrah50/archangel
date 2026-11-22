import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { requireTransition } from "../src/cli/transition.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson, okWorkflow } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function world(implementer: (input: { abortController: AbortController }) => Promise<unknown>, setup?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-errcat-"));
  const seed = path.join(root, "seed");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@t"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
  if (setup !== undefined) fs.writeFileSync(path.join(seed, ".agents", "setup"), setup);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "i"]);
  git(root, ["clone", "-q", "--bare", seed, path.join(root, "remote.git")]);
  const github = new FakeGitHub(path.join(root, "remote.git"));
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
  const rec = new Reconciler({
    config: cfg, ledger, github,
    broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
    implementer: { run: implementer as never },
    reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
    notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
  });
  github.issues.set(4, { number: 4, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString() });
  github.labelActors.set("4:ready-for-agent", 999);
  return { root, github, ledger, rec };
}
const cleanup = (w: { root: string; ledger: Ledger }) => {
  w.ledger.close();
  fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
};


const lastAttempt = (w: { ledger: Ledger }) => w.ledger.listAttemptsFor(4).at(-1)!;

describe("an Attempt records why it ended, at the source", () => {
  it("a repo .agents/setup that exits non-zero is setup_failed, not provider_unavailable", async () => {
    const w = await world(async () => {
      throw new Error("unused");
    }, "echo broken dependency install >&2\nexit 3\n");
    try {
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      const a = lastAttempt(w);
      expect(a.status).toBe("failed");
      expect(a.errorMessage).toMatch(/exit|Command failed|3/i);
      expect(a.errorCategory).toBe("setup_failed");
      expect(w.ledger.computeMetrics({ now: Date.now() }).attempts.errorCategories).toMatchObject({ setup_failed: 1 });
    } finally {
      cleanup(w);
    }
  });

  it("an implementer that throws is provider_unavailable; one that reports a failure is implementer_failed", async () => {
    const w = await world(async () => {
      throw new Error("all providers exhausted, whatever the wording");
    });
    try {
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(lastAttempt(w).errorCategory).toBe("provider_unavailable");
    } finally {
      cleanup(w);
    }
    const f = await world(async () => ({ summary: "", costUsd: 0, transcriptPath: null, aborted: false, failure: "error_max_turns" }));
    try {
      await f.rec.tick(Date.now(), { waitForAttempts: true });
      expect(lastAttempt(f).errorCategory).toBe("implementer_failed");
    } finally {
      cleanup(f);
    }
  });

  it("finishAttempt stores the category and a successful Attempt has none", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    l.upsertThread({ issueNumber: 1, title: "t", bodySha256: "s", now: 1 });
    const a = l.startAttempt(1, "implement", 1);
    expect(l.finishAttempt(a.id, { status: "failed", errorMessage: "x", errorCategory: "no_change" }, 2).errorCategory).toBe("no_change");
    const b = l.startAttempt(1, "implement", 3);
    expect(l.finishAttempt(b.id, { status: "succeeded" }, 4).errorCategory).toBeNull();
  });
});

describe("revise and rebase Attempts are captured for replay", () => {
  it("stores a revision's sanitized input and pre-attempt head, and pins the head", async () => {
    const w = await world(async () => ({ summary: "", costUsd: 0, transcriptPath: null, aborted: false }));
    try {
      const broker = (w.rec as unknown as { broker: GitBroker }).broker;
      const pin = vi.spyOn(broker, "pinEvalRef").mockResolvedValue("" as never);
      const head = "b".repeat(40);
      const main = "c".repeat(40);
      w.ledger.upsertThread({ issueNumber: 4, title: "Bug", bodySha256: "x", now: 1, phase: { kind: "awaiting_gate", prNumber: 9, headSha: head, baseSha: "d".repeat(40), since: 1, nudgedAt: null } as never });
      const spawn = (kind: "revise" | "rebase") =>
        (w.rec as unknown as { spawnAttempt: (...a: unknown[]) => Promise<boolean> }).spawnAttempt(
          w.ledger.getThread(4), w.github.issues.get(4), kind, main,
          ["no new test file added"], [{ vendor: "openai", findings: [{ file: "a.go", severity: "major", summary: "add a test" }] }], Date.now(),
        );
      (w.rec as unknown as { workflow: unknown }).workflow = okWorkflow([]);
      expect(await spawn("revise")).toBe(true);
      await w.rec.tick(Date.now(), { waitForAttempts: true }).catch(() => undefined);
      const inputs = w.ledger.listAttemptInputs();
      expect(inputs[0]).toMatchObject({ kind: "revise", fromSha: head, input: { kind: "revise", gateViolations: ["no new test file added"] } });
      expect(pin.mock.calls.map((c) => c[2])).toContain(head);
    } finally {
      cleanup(w);
    }
  });
});
