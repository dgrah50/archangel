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

describe("an Attempt aborted for control does not consume attempt budget", () => {
  it("a flapping pause label cannot exhaust maxImplementAttemptsPerThread with no real work done", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-refund-"));
    const seed = path.join(root, "seed");
    const remoteBare = path.join(root, "remote.git");
    fs.mkdirSync(seed);
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.name", "T"]);
    git(seed, ["config", "user.email", "t@example.com"]);
    fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 1 }\n");
    fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "initial"]);
    git(root, ["clone", "--bare", seed, remoteBare]);

    const github = new FakeGitHub(remoteBare);
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
    const notifier: Notifier = { async notifyNeedsYou() {}, async sendDigest() {} };
    let runs = 0;
    const implementer: Implementer = {
      async run(input) {
        runs++;
        fs.writeFileSync(path.join((await input.workspaces.local.workspace()).path, "app.go"), `package demo\n\nfunc Val() int { return ${10 + runs} }\n`);
        git((await input.workspaces.local.workspace()).path, ["add", "-A"]);
        git((await input.workspaces.local.workspace()).path, ["commit", "-m", `attempt ${runs}`]);
        // The owner pauses the factory while the Attempt is running: caught by the check right before the push.
        github.issues.get(7)!.labels.push("factory:paused");
        return { summary: "ok", costUsd: 0, transcriptPath: null, aborted: false };
      },
    };
    const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
    const cfg = ConfigSchema.parse({
      githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2,
      githubPrivateKeyPem: "fake", maxImplementAttemptsPerThread: 2,
    });
    const reconciler = new Reconciler({ triageInvoker: noCli, config: cfg, ledger, github, broker, implementer, reviewers, notifier });
    try {
      github.issues.set(7, {
        number: 7, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o",
        authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString(),
      });
      github.labelActors.set("7:ready-for-agent", 999);
      for (let i = 0; i < 5; i++) {
        await reconciler.tick(Date.now() + i * 1000, { waitForAttempts: true });
        // Resume: the owner removes the pause label again (flapping).
        github.issues.get(7)!.labels = github.issues.get(7)!.labels.filter((l) => l !== "factory:paused");
      }
      expect(runs).toBeGreaterThanOrEqual(3); // more Attempts than the cap of 2: none of them counted
      expect(ledger.getThread(7)?.implementCount).toBe(0);
      expect(ledger.getThread(7)?.phase.kind).not.toBe("needs_you");
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

});
