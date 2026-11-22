import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { describe, expect, it } from "bun:test";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { type CheckStatus } from "../src/core/blockers.js";
import type { Notifier } from "../src/core/notifier.js";
import { Reconciler } from "../src/core/reconciler.js";
import { classifyGate, stepPhase, type Phase } from "../src/core/thread-machine.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const MIN = 60_000;
const gh = (name: string, status: CheckStatus["status"], conclusion: string | null, id = 1): CheckStatus & { id: number } => ({
  id,
  name,
  status,
  conclusion,
  appSlug: "github-actions",
});
const base = { requiredChecks: ["Gate", "Test"], since: 0, graceMs: 5 * MIN, timeoutMs: 60 * MIN };

describe("CI waiting rules", () => {
  it("escalates when a required check never appears within 5 minutes, naming missing and present checks", () => {
    const r = classifyGate({ ...base, checks: [gh("Test", "completed", "success")], now: 6 * MIN });
    expect(r.status).toBe("timeout");
    if (r.status !== "timeout") throw new Error("unreachable");
    expect(r.detail).toContain("Gate");
    expect(r.detail).toContain("Gate=missing");
    expect(r.detail).toContain("Test=success");
  });

  it("keeps waiting on pending checks past 5 minutes but stops after 1 hour with observed states", () => {
    const checks = [gh("Gate", "in_progress", null), gh("Test", "completed", "success", 2)];
    expect(classifyGate({ ...base, checks, now: 59 * MIN }).status).toBe("pending");
    const r = classifyGate({ ...base, checks, now: 61 * MIN });
    expect(r.status).toBe("timeout");
    if (r.status !== "timeout") throw new Error("unreachable");
    expect(r.detail).toContain("Gate=in_progress");
    expect(r.detail).toContain("Test=success");
  });

});

describe("autonomy cap", () => {

  it("stops starting Attempts at the cap, notifies once, and resumes after an owner action", async () => {
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-cap-"));
    const seed = path.join(root, "seed");
    const remoteBare = path.join(root, "remote.git");
    fs.mkdirSync(seed);
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.name", "T"]);
    git(seed, ["config", "user.email", "t@example.com"]);
    fs.writeFileSync(path.join(seed, "go.mod"), "module example.com/demo\n\ngo 1.26.0\n");
    fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 1 }\n");
    fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "initial"]);
    git(root, ["clone", "--bare", seed, remoteBare]);

    const github = new FakeGitHub(remoteBare);
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
    const notes: Array<{ decisionClass: string; recommendation: string }> = [];
    const notifier: Notifier = { async notifyNeedsYou(i) { notes.push(i); }, async sendDigest() {} };
    let calls = 0;
    const implementer: Implementer = {
      async run(input) {
        calls++;
        fs.writeFileSync(path.join(input.cloneDir, "app.go"), `package demo\n\nfunc Val() int { return ${40 + calls} }\n`);
        git(input.cloneDir, ["add", "-A"]);
        git(input.cloneDir, ["commit", "-m", "fix"]);
        return { summary: "ok", costUsd: 0.1, transcriptPath: null, aborted: false };
      },
    };
    const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
    const cfg = ConfigSchema.parse({
      githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2,
      githubPrivateKeyPem: "fake", maxAutonomousStepsWithoutOwner: 1,
      requiredChecks: ["Gate"],
    });
    const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });
    try {
      for (const n of [2, 3]) {
        github.issues.set(n, {
          number: n, title: `Bug ${n}`, body: "b", state: "open", authorId: 999, authorLogin: "o",
          authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString(),
        });
        github.labelActors.set(`${n}:ready-for-agent`, 999);
      }
      await reconciler.tick(Date.now(), { waitForAttempts: true });
      await reconciler.tick(Date.now(), { waitForAttempts: true });
      expect(calls).toBe(1);
      expect(ledger.autonomousStepsSinceOwner()).toBe(1);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.decisionClass).toBe("spending");
      expect(notes[0]!.recommendation).toMatch(/archangel retry/);

      ledger.appendAudit("thread/owner_reply", 3, "owner", {});
      await reconciler.tick(Date.now(), { waitForAttempts: true });
      expect(calls).toBe(2);
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
