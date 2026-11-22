import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { Implementer } from "../src/agents/implementer.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";
import { noCli } from "./helpers/no-cli.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("a PR merged on GitHub", () => {
  it("counts as hearing from the owner only when the configured owner merged it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-ownermerge-"));
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
    const implementer: Implementer = {
      async run() {
        throw new Error("no attempt expected");
      },
    };
    const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
    const rec = new Reconciler({ triageInvoker: noCli,
      config: cfg, ledger, github, broker, implementer,
      reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
      notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
    });
    try {
      const sha = git(remoteBare, ["rev-parse", "main"]);
      const track = (issue: number, pr: number, mergedBy: number) => {
        ledger.upsertThread({
          issueNumber: issue,
          title: `t${issue}`,
          bodySha256: "x",
          phase: { kind: "awaiting_gate", prNumber: pr, headSha: sha, baseSha: sha, since: 1, nudgedAt: 0 },
        });
        github.issues.set(issue, {
          number: issue, title: `t${issue}`, body: "b", state: "open", authorId: 999, authorLogin: "o",
          authorAssociation: "OWNER", labels: [], updatedAt: new Date().toISOString(),
        });
        github.prs.set(pr, {
          number: pr, title: "p", state: "closed", merged: true, mergeCommitSha: "m", mergedBy, draft: false,
          headRef: `h${pr}`, headSha: sha, baseRef: "main", baseSha: sha, labels: [], changedFiles: [],
        });
      };
      ledger.appendAudit("attempt/started", 1, "archangel", {});
      track(1, 10, 123);
      await rec.tick(Date.now(), { waitForAttempts: true });
      expect(ledger.getThread(1)!.phase).toMatchObject({ kind: "done", outcome: "owner_merged" });
      expect(ledger.autonomousStepsSinceOwner()).toBe(1);

      track(2, 11, 999);
      await rec.tick(Date.now(), { waitForAttempts: true });
      expect(ledger.getThread(2)!.phase).toMatchObject({ kind: "done", outcome: "owner_merged" });
      expect(ledger.autonomousStepsSinceOwner()).toBe(0);
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
