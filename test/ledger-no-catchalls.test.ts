import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, spyOn } from "bun:test";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import type { Notifier } from "../src/core/notifier.js";
import { Reconciler } from "../src/core/reconciler.js";
import { runScoutsForProject } from "../src/core/scout.js";
import type { GitHubClient, GitHubIssue } from "../src/github/client.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { scoutDeps } from "./helpers/scout-deps.js";
import { goWorkflowJson, okWorkflow, workflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(workflow: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-catchall-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(path.join(seed, ".agents", "scouts"), { recursive: true });
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@example.com"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), workflow);
  fs.writeFileSync(path.join(seed, ".agents", "scouts", "hunt.md"), "Find bugs.\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "init"]);
  const mainSha = git(seed, ["rev-parse", "HEAD"]);
  git(root, ["clone", "--bare", seed, remoteBare]);
  return { root, remoteBare, mainSha };
}

describe("Ledger read errors are not swallowed", () => {
  it("intake fails closed for one issue when the proposal lookup breaks, without failing the tick or other issues", async () => {
    const { root, remoteBare } = repo(goWorkflowJson());
    const github = new FakeGitHub(remoteBare);
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    // The Reconciler works on a per-repo view of the Ledger, so patch the prototype, not the instance.
    const spy = spyOn(Ledger.prototype, "getScoutProposal").mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });
    const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
    const notifier: Notifier = { async notifyNeedsYou() {}, async sendDigest() {} };
    const implementer: Implementer = { async run() { throw new Error("no work in this test"); } };
    const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
    const cfg = ConfigSchema.parse({
      githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2,
      githubPrivateKeyPem: "fake", githubAppBotUserId: 777,
    });
    const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });
    try {
      // A bot-authored proposal (needs the failing lookup) and an ordinary owner issue.
      github.issues.set(2, { number: 2, title: "Proposal", body: "b", state: "open", authorId: 777, authorLogin: "app[bot]", authorAssociation: "NONE", labels: ["ready-for-agent"], updatedAt: "" });
      github.issues.set(3, { number: 3, title: "Owner bug", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: "" });
      github.labelActors.set("2:ready-for-agent", 999);
      github.labelActors.set("3:ready-for-agent", 999);
      await expect(reconciler.tick(Date.now(), { waitForAttempts: true })).resolves.toBeUndefined();
      expect(ledger.getThread(2)).toBeNull(); // not intaken on a broken read
      expect(ledger.getThread(3)).not.toBeNull(); // the other issue was unaffected
    } finally {
      spy.mockRestore();
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

});
