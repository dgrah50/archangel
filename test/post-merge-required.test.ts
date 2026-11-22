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

describe("merges always record which main checks to watch", () => {
  it("refuses to record an autonomous merge with no required main checks", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    l.upsertThread({ issueNumber: 1, title: "t", bodySha256: "b", now: 1 });
    expect(() => l.recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h", squashSha: "s", shadowOnly: false, now: 1 })).toThrow(/mainRequired/);
    expect(() => l.recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h", squashSha: "s", shadowOnly: false, mainRequired: [], now: 1 })).toThrow(/mainRequired/);
    expect(l.recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h", squashSha: "s", shadowOnly: false, mainRequired: ["Test"], now: 1 }).mainRequired).toEqual(["Test"]);
    // shadow verdicts watch nothing
    expect(l.recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h2", shadowOnly: true, now: 1 }).mainRequired).toEqual([]);
  });

  it("a row with no recorded checks (from before they were recorded) is closed out loudly, not skipped forever", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-pm-"));
    const seed = path.join(root, "seed");
    const remoteBare = path.join(root, "remote.git");
    fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.name", "T"]);
    git(seed, ["config", "user.email", "t@example.com"]);
    fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
    fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "initial"]);
    git(root, ["clone", "--bare", seed, remoteBare]);
    const github = new FakeGitHub(remoteBare);
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
    const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
    try {
      ledger.upsertThread({ issueNumber: 5, title: "t", bodySha256: "b", phase: { kind: "done", outcome: "merged" }, now: 1 });
      (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
        .prepare(
          `INSERT INTO merges (repo, issue_number, pr_number, head_sha, squash_sha, shadow_only, day_key, main_watch_json, created_at)
           VALUES ('acme/app', 5, 9, 'h', 'abc', 0, '2026-11-21', '{"kind":"watching","since":1}', 1)`,
        )
        .run();
      const reconciler = new Reconciler({
        config: cfg, ledger, github, broker,
        implementer: { async run() { return { summary: "", costUsd: 0, transcriptPath: null, aborted: true }; } },
        reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
        notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
      });
      await reconciler.tick(Date.now(), { waitForAttempts: true });
      expect(ledger.listPendingPostMergeChecks()).toEqual([]);
      expect(ledger.getMerge(1)!.mainWatch.kind).toBe("timed_out");
      expect(ledger.listAudit({ topicPrefix: "post_merge/missing_required_checks" })).toHaveLength(1);
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
