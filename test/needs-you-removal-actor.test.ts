import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-nyr-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@example.com"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "i"]);
  git(root, ["clone", "-q", "--bare", seed, remoteBare]);
  const github = new FakeGitHub(remoteBare);
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
  const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
  const rec = new Reconciler({
    config: cfg, ledger, github, broker,
    implementer: { async run() { throw new Error("unused"); } },
    reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
    notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
  });
  // A Thread parked in needs_you, with the needs-you label on the issue.
  github.issues.set(4, {
    number: 4, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER",
    labels: ["needs-you"], updatedAt: new Date().toISOString(),
  });
  const t = ledger.upsertThread({ issueNumber: 4, title: "Bug", bodySha256: sha("b"), now: 1 });
  ledger.transition(4, t.version, { kind: "needs_you", code: "review_vetoed", reason: "x", resumeTo: { kind: "queued" } } as never, { now: 2 });
  return { root, github, ledger, rec };
}
import crypto from "node:crypto";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe("removing needs-you resumes a Thread only when the owner removed it", () => {
  it("ignores a removal by anyone else, restores the label, and records it", async () => {
    const w = await world();
    try {
      w.github.issues.get(4)!.labels = []; // someone removed the label
      w.github.labelRemovers.set("4:needs-you", 555); // ...and it was not the owner (id 999)
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(w.ledger.getThread(4)!.phase.kind).toBe("needs_you");
      expect(w.ledger.getThread(4)!.retryGrants).toBe(0);
      expect(w.github.issues.get(4)!.labels).toContain("needs-you");
      expect(w.ledger.listAudit({ topicPrefix: "thread/needs_you_label_removed_by_other" })).toHaveLength(1);
      expect(w.ledger.listAudit({ topicPrefix: "thread/owner_retry" })).toHaveLength(0);
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("still resumes (with a retry grant) when the owner removed it", async () => {
    const w = await world();
    try {
      w.github.issues.get(4)!.labels = [];
      w.github.labelRemovers.set("4:needs-you", 999);
      await w.rec.tick(Date.now(), { waitForAttempts: false });
      expect(w.ledger.getThread(4)!.retryGrants).toBe(1);
      expect(w.ledger.listAudit({ topicPrefix: "thread/owner_retry" })).toHaveLength(1);
      w.rec.abortAllActive("control");
      await w.rec.waitForActiveTasks();
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("a dead-lettered needs-you label add is not read as the owner retrying", async () => {
    const w = await world();
    try {
      w.github.issues.get(4)!.labels = []; // our add_label never landed
      w.github.labelRemovers.set("4:needs-you", 0); // the timeline has no owner removal
      w.ledger.upsertThread({ issueNumber: 5, title: "x", bodySha256: sha("x"), now: 1 });
      w.ledger.transition(5, w.ledger.getThread(5)!.version, { kind: "queued" }, { effects: [{ kind: "add_label", issueNumber: 4, label: "needs-you" }] });
      const row = w.ledger.listDueOutbox()[0]!;
      w.ledger.deadLetterOutbox(row.id, "gave up");
      expect(w.ledger.hasPendingLabelAdd(4, "needs-you")).toBe(false);
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(w.ledger.getThread(4)!.phase.kind).toBe("needs_you");
      expect(w.ledger.getThread(4)!.retryGrants).toBe(0);
      expect(w.ledger.listAudit({ topicPrefix: "thread/owner_retry" })).toHaveLength(0);
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
