import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import type { Notifier } from "../src/core/notifier.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("a free Attempt slot is a scheduling matter, not an escalation", () => {
  it("keeps a Gate-failed Thread waiting while every slot is busy instead of escalating gate_failed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-busy-"));
    const seed = path.join(root, "seed");
    const remoteBare = path.join(root, "remote.git");
    fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.name", "T"]);
    git(seed, ["config", "user.email", "t@example.com"]);
    fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), "{}\n");
    fs.writeFileSync(path.join(seed, "a.txt"), "x\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "init"]);
    git(root, ["clone", "--bare", seed, remoteBare]);
    const mainSha = git(remoteBare, ["rev-parse", "refs/heads/main"]);

    const github = new FakeGitHub(remoteBare);
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const implementer: Implementer = { async run() { throw new Error("must not run"); } };
    const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
    const notifier: Notifier = { async notifyNeedsYou() {}, async sendDigest() {} };
    const cfg = ConfigSchema.parse({
      githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2,
      githubPrivateKeyPem: "fake", requiredChecks: ["Gate"], maxConcurrentThreads: 1,
    });
    const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
    const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });
    try {
      github.issues.set(5, {
        number: 5, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o",
        authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString(),
      });
      ledger.upsertThread({
        issueNumber: 5, title: "Bug", bodySha256: crypto.createHash("sha256").update("b").digest("hex"),
        phase: { kind: "awaiting_gate", prNumber: 100, headSha: mainSha, baseSha: mainSha, since: Date.now(), nudgedAt: null },
      });
      github.prs.set(100, {
        number: 100, title: "pr", state: "open", merged: false, mergeCommitSha: null, draft: false,
        headRef: "main", headSha: mainSha, baseRef: "main", baseSha: mainSha, labels: [], changedFiles: [],
      });
      github.checks.set(mainSha, [{ id: 1, name: "Gate", status: "completed", conclusion: "failure", appSlug: "github-actions" }]);
      // Another Thread's Attempt occupies the only slot.
      (reconciler as unknown as { runningTasks: Map<number, unknown> }).runningTasks.set(99, {});

      await reconciler.tick(Date.now());
      expect(ledger.getThread(5)?.phase.kind).toBe("awaiting_gate");
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
