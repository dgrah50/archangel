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

describe("owner retry after an exhausted budget", () => {
  it("grants one more revision, so the owner's reply reaches an Attempt instead of re-escalating on the same red SHA", async () => {
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-retry-"));
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
    const prompts: string[] = [];
    const implementer: Implementer = {
      async run(input) {
        prompts.push(input.prompt);
        fs.writeFileSync(path.join(input.cloneDir, "app.go"), `package demo\n\nfunc Val() int { return ${10 + prompts.length} }\n`);
        git(input.cloneDir, ["add", "-A"]);
        git(input.cloneDir, ["commit", "-m", `attempt ${prompts.length}`]);
        return { summary: "ok", costUsd: 0, transcriptPath: null, aborted: false };
      },
    };
    const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
    const cfg = ConfigSchema.parse({
      githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2,
      githubPrivateKeyPem: "fake", maxRevisionsPerThread: 0,
    });
    const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });
    const red = [
      { id: 1, name: "Gate", status: "completed" as const, conclusion: "failure", appSlug: "github-actions" },
      { id: 2, name: "Test", status: "completed" as const, conclusion: "success", appSlug: "github-actions" },
    ];
    try {
      github.issues.set(4, {
        number: 4, title: "Bug 4", body: "Val should be 12", state: "open", authorId: 999, authorLogin: "o",
        authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString(),
      });
      github.labelActors.set("4:ready-for-agent", 999);

      await reconciler.tick(Date.now(), { waitForAttempts: true }); // implement -> PR
      const phase = ledger.getThread(4)!.phase as { headSha: string };
      github.checks.set(phase.headSha, red);
      await reconciler.tick(Date.now(), { waitForAttempts: true }); // red Gate, no revision budget -> needs_you
      expect(ledger.getThread(4)?.phase).toMatchObject({ kind: "needs_you", code: "gate_failed" });
      await reconciler.tick(Date.now(), { waitForAttempts: true }); // outbox adds needs-you label
      expect(github.issues.get(4)!.labels).toContain("needs-you");

      const later = Date.now() + 1_000;
      github.authoredComments.set(4, [{ userId: 999, createdAt: later, body: "Return 12, not 11." }]);
      github.issues.get(4)!.labels = ["ready-for-agent"];
      await reconciler.tick(later + 1, { waitForAttempts: true });

      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Return 12, not 11.");
      expect(ledger.getThread(4)?.retryGrants).toBe(1);
      expect(ledger.getThread(4)?.phase.kind).toBe("awaiting_gate");
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
