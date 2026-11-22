import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, spyOn } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson, okWorkflow } from "./helpers/workflow.js";
import { noCli } from "./helpers/no-cli.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
type Priv = {
  spawnAttempt: (...a: unknown[]) => Promise<boolean>;
  rebaseOntoMain: (...a: unknown[]) => Promise<void>;
  workflow: unknown;
  runningTasks: Map<number, unknown>;
};

const sql = (l: Ledger, q: string, ...a: unknown[]) => (l as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db.prepare(q).run(...a);

function world(factoryRetry: "off" | "once") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-fretry-"));
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
  const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
  const notes: string[] = [];
  const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
  const rec = new Reconciler({ triageInvoker: noCli,
    config: cfg, ledger, github, broker,
    implementer: { run: (async () => { throw new Error("no clone in this test"); }) as never },
    reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
    notifier: { async notifyNeedsYou(i) { notes.push(i.title); }, async sendDigest() {} },
  });
  (rec as unknown as Priv).workflow = okWorkflow([], { extra: { escalations: { factoryRetry } } });
  github.issues.set(4, { number: 4, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: "" });
  spyOn(broker, "getDiffAndTouchedFiles").mockResolvedValue({ diffText: "+OLD-PATCH-LINE", touchedFiles: {} });
  const spawn = spyOn(rec as unknown as Priv, "spawnAttempt").mockResolvedValue(true);
  const start = (rebaseCount = 1) => {
    ledger.upsertThread({ issueNumber: 4, title: "Bug", bodySha256: "x", phase: { kind: "awaiting_gate", prNumber: 9, headSha: "h", baseSha: "b", since: 1, nudgedAt: null } });
    sql(ledger, "UPDATE threads SET rebase_count = ? WHERE issue_number = 4", rebaseCount);
  };
  const conflict = () =>
    (rec as unknown as Priv).rebaseOntoMain(ledger.getThread(4), { number: 9, headSha: "h", baseSha: "b", labels: [] }, github.issues.get(4), "mainsha", false, [], Date.now());
  return { root, ledger, rec, spawn, start, conflict, notes, github, cleanup: () => { ledger.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

describe("merge_conflict after the rebase budget (factory retry)", () => {

  it("with the knob on, starts one fresh implement from the new main with the old diff as reference, under the factory actor", async () => {
    const w = world("once");
    try {
      w.start();
      await w.conflict();
      expect(w.spawn).toHaveBeenCalledTimes(1);
      const args = w.spawn.mock.calls[0]!;
      expect(args[2]).toBe("implement");
      expect(args[3]).toBe("mainsha");
      expect(args[7]).toBe("mainsha"); // starts from the new main, not the conflicted head
      expect(args[8]).toBe(true); // the kernel-fixed allowance
      const t = w.ledger.getThread(4)!;
      expect(t.phase.kind).toBe("awaiting_gate"); // not escalated
      expect(t.factoryRetries).toBe(1);
      expect(t.factoryGuidance).toContain("+OLD-PATCH-LINE");
      expect(t.ownerReply).toBeNull(); // machine text never lands in the owner's slot
      expect(w.ledger.listAudit({ topicPrefix: "factory/retry" })[0]).toMatchObject({ actor: "factory" });
    } finally {
      w.cleanup();
    }
  });

});

describe("the factory retry does not touch the implement budget", () => {
  it("runs even when implement attempts are spent, without counting as one; a normal implement is refused", async () => {
    const w = world("once");
    try {
      w.spawn.mockRestore();
      w.start();
      sql(w.ledger, "UPDATE threads SET implement_count = 99 WHERE issue_number = 4");
      const spawn = (...a: unknown[]) => (w.rec as unknown as Priv).spawnAttempt(w.ledger.getThread(4), w.github.issues.get(4), "implement", "mainsha", [], [], Date.now(), "mainsha", ...a);
      expect(await spawn(false)).toBe(false);
      expect(w.ledger.getThread(4)!.phase).toMatchObject({ kind: "needs_you", code: "max_attempts" });
    } finally {
      w.cleanup();
    }
    const f = world("once");
    try {
      f.spawn.mockRestore();
      f.start();
      sql(f.ledger, "UPDATE threads SET implement_count = 99 WHERE issue_number = 4");
      expect(await (f.rec as unknown as Priv).spawnAttempt(f.ledger.getThread(4), f.github.issues.get(4), "implement", "mainsha", [], [], Date.now(), "mainsha", true)).toBe(true);
      await f.rec.waitForActiveTasks();
      expect(f.ledger.getThread(4)!.implementCount).toBe(99);
    } finally {
      f.cleanup();
    }
  });
});
