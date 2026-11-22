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
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function world(implementer: (input: { abortController: AbortController }) => Promise<never>, over: object = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-abortcause-"));
  const seed = path.join(root, "seed");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@t"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "i"]);
  git(root, ["clone", "-q", "--bare", seed, path.join(root, "remote.git")]);
  const github = new FakeGitHub(path.join(root, "remote.git"));
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake", ...over });
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

describe("an abort nobody asked for is a timeout, not a control abort", () => {
  it("escalates attempt_timeout and does not refund the budget when a thrown error follows an unrequested abort", async () => {
    const w = await world(async (input) => {
      input.abortController.abort(new Error("attempt timer")); // the Attempt's own timer, not the owner and not a halt
      throw new Error("boom");
    });
    try {
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(w.ledger.getThread(4)!.phase).toMatchObject({ kind: "needs_you", code: "attempt_timeout" });
      expect(w.ledger.getThread(4)!.implementCount).toBe(1); // not refunded: a timeout spends the Attempt
    } finally {
      cleanup(w);
    }
  });
});

describe("rebase budget honours the owner's retry grants", () => {
  it("lets a merge_conflict retry rebase again instead of re-escalating on the same conflict", async () => {
    const w = await world(async () => {
      throw new Error("unused");
    });
    try {
      const spawn = vi.spyOn(w.rec as unknown as { spawnAttempt: (...a: unknown[]) => Promise<boolean> }, "spawnAttempt").mockResolvedValue(true);
      const pr = { number: 9, headSha: "h", baseSha: "b", labels: [] } as never;
      const issue = w.github.issues.get(4)!;
      const rebase = (thread: unknown) => (w.rec as unknown as { rebaseOntoMain: (...a: unknown[]) => Promise<void> }).rebaseOntoMain(thread, pr, issue, "main", false, [], Date.now());
      const base = { issueNumber: 4, rebaseCount: 1, phase: { kind: "awaiting_gate", prNumber: 9, headSha: "h", baseSha: "b", since: 1, nudgedAt: null }, mode: "autonomous", version: 0, title: "t" };
      await rebase({ ...base, retryGrants: 0 }); // budget (1) is spent: escalates, spawns nothing
      expect(spawn).not.toHaveBeenCalled();
      await rebase({ ...base, retryGrants: 1 }); // the owner retried: one more rebase
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(w);
    }
  });
});

describe("owner commands do not report success for a lost compare-and-set", () => {
  it("throws when the transition returned null, and passes the updated Thread through otherwise", () => {
    expect(() => requireTransition(null, "a/b", 7)).toThrow(/a\/b#7 changed while this command ran/);
    const t = { issueNumber: 7 } as never;
    expect(requireTransition(t, "a/b", 7)).toBe(t);
  });
});
