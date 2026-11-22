import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
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
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setup(actor: number | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-disagree-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(seed);
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@example.com"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  git(root, ["clone", "--bare", seed, remoteBare]);
  const mainSha = git(remoteBare, ["rev-parse", "refs/heads/main"]);

  const github = new FakeGitHub(remoteBare);
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
  const notifier: Notifier = { async notifyNeedsYou() {}, async sendDigest() {} };
  const implementer: Implementer = { async run() { throw new Error("must not run"); } };
  const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
  const cfg = ConfigSchema.parse({
    githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2,
    githubPrivateKeyPem: "fake", githubAppBotUserId: 777, shadowMode: true,
  });
  const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });
  github.issues.set(7, {
    number: 7, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER",
    labels: ["factory:disagree"], updatedAt: new Date().toISOString(),
  });
  if (actor !== null) github.labelActors.set("7:factory:disagree", actor);
  ledger.upsertThread({
    issueNumber: 7, title: "Bug", bodySha256: crypto.createHash("sha256").update("b").digest("hex"),
    phase: { kind: "shadow_ready", prNumber: 100, headSha: mainSha, baseSha: mainSha, verdictId: 1 },
  });
  github.prs.set(100, {
    number: 100, title: "pr", state: "open", merged: false, mergeCommitSha: null, draft: false,
    headRef: "main", headSha: mainSha, baseRef: "main", baseSha: mainSha, labels: [], changedFiles: [],
  });
  ledger.recordMerge({ issueNumber: 7, prNumber: 100, headSha: mainSha, shadowOnly: true });
  return { github, ledger, reconciler, cleanup: () => { ledger.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

const disagreed = (l: Ledger) => l.getShadowStats().disagreed;

describe("factory:disagree counts only when the owner applied it", () => {
  it("ignores a label applied by someone else, with one audit row, and does not write an owner action", async () => {
    const s = setup(555);
    try {
      await s.reconciler.tick(Date.now());
      await s.reconciler.tick(Date.now() + 1000);
      expect(disagreed(s.ledger)).toBe(0);
      expect(s.ledger.listAudit({ topicPrefix: "shadow/disagree_ignored" })).toHaveLength(1);
      expect(s.ledger.listAudit({ topicPrefix: "shadow/disagree" }).filter((a) => a.actor === "owner")).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  it("counts a label applied by the owner, or by the Archangel App (the owner's `archangel disagree`)", async () => {
    for (const actor of [999, 777]) {
      const s = setup(actor);
      try {
        await s.reconciler.tick(Date.now());
        expect(disagreed(s.ledger), `actor ${actor}`).toBe(1);
        expect(s.ledger.listAudit({ topicPrefix: "shadow/disagree_ignored" })).toEqual([]);
      } finally {
        s.cleanup();
      }
    }
  });

  it("clears the disagreement when the label is removed", async () => {
    const s = setup(999);
    try {
      await s.reconciler.tick(Date.now());
      expect(disagreed(s.ledger)).toBe(1);
      s.github.issues.get(7)!.labels = [];
      await s.reconciler.tick(Date.now() + 1000);
      expect(disagreed(s.ledger)).toBe(0);
    } finally {
      s.cleanup();
    }
  });
});
