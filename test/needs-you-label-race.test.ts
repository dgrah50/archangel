import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import type { Notifier } from "../src/core/notifier.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";
import { noCli } from "./helpers/no-cli.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("needs-you label that has not landed yet", () => {
  it("is not mistaken for the owner removing it (no auto-retry, no free retry grant)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-label-race-"));
    const seed = path.join(root, "seed");
    const remoteBare = path.join(root, "remote.git");
    fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.name", "T"]);
    git(seed, ["config", "user.email", "t@example.com"]);
    fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
    fs.writeFileSync(path.join(seed, "a.txt"), "x\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "init"]);
    git(root, ["clone", "--bare", seed, remoteBare]);

    const github = new FakeGitHub(remoteBare);
    // The label API is failing, so the outbox add_label for needs-you stays pending.
    github.addLabels = async () => {
      throw new Error("GitHub 503");
    };
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    let runs = 0;
    const implementer: Implementer = {
      async run() {
        runs++;
        throw new Error("boom");
      },
    };
    const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
    const notifier: Notifier = { async notifyNeedsYou() {}, async sendDigest() {} };
    const cfg = ConfigSchema.parse({
      githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2,
      githubPrivateKeyPem: "fake",
    });
    const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
    const reconciler = new Reconciler({ triageInvoker: noCli, config: cfg, ledger, github, broker, implementer, reviewers, notifier });
    try {
      github.issues.set(5, {
        number: 5, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o",
        authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString(),
      });
      github.labelActors.set("5:ready-for-agent", 999);
      for (let i = 0; i < 4; i++) await reconciler.tick(Date.now() + i * 1000, { waitForAttempts: true });
      expect(ledger.getThread(5)?.phase.kind).toBe("needs_you");
      expect(ledger.getThread(5)?.retryGrants).toBe(0);
      expect(runs).toBe(1);
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
