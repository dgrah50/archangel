import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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


describe("a handoff whose push fails is an explicit state, not a silent drop", () => {
  it("records handoff/push_failed and tells the owner on the issue", async () => {
    const w = await world(async (input) => {
      fs.writeFileSync(path.join((input as unknown as { cloneDir: string }).cloneDir, "work.go"), "package demo\n");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 4000);
        input.abortController.signal.addEventListener("abort", () => (clearTimeout(t), resolve()));
      });
      return { summary: "", costUsd: 0, transcriptPath: null, aborted: input.abortController.signal.aborted } as never;
    });
    try {
      await w.rec.tick(Date.now(), { waitForAttempts: false });
      await new Promise((r) => setTimeout(r, 400));
      expect(w.ledger.getThread(4)!.phase.kind).toBe("working");
      const broker = (w.rec as unknown as { broker: GitBroker }).broker;
      vi.spyOn(broker, "pushFactoryBranch").mockRejectedValue(new Error("remote rejected the push"));
      const mainSha = git(path.join(w.root, "remote.git"), ["rev-parse", "main"]);
      await w.rec.prepareDaemonHandoff(4, mainSha);
      await w.rec.tick(Date.now(), { waitForAttempts: true }).catch(() => undefined);
      const rows = w.ledger.listAudit({ topicPrefix: "handoff/push_failed" });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).toContain("remote rejected the push");
      const said = (w.github.comments.get(4) ?? []).join("\n");
      expect(said).toContain("could not be pushed");
    } finally {
      cleanup(w);
    }
  });
});
