import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { describe, expect, it } from "vitest";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { computeBlockers, type CheckStatus } from "../src/core/blockers.js";
import type { Notifier } from "../src/core/notifier.js";
import { Reconciler } from "../src/core/reconciler.js";
import { classifyGate, stepPhase, type Phase } from "../src/core/thread-machine.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";

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
  it("keeps waiting for a missing check inside the 5 minute grace window", () => {
    const r = classifyGate({ ...base, checks: [gh("Test", "completed", "success")], now: 4 * MIN });
    expect(r).toEqual({ status: "missing_grace", missing: ["Gate"] });
  });

  it("escalates when a required check never appears within 5 minutes, naming missing and present checks", () => {
    const r = classifyGate({ ...base, checks: [gh("Test", "completed", "success")], now: 6 * MIN });
    expect(r.status).toBe("timeout");
    if (r.status !== "timeout") throw new Error("unreachable");
    expect(r.detail).toContain("Gate");
    expect(r.detail).toContain("Gate=missing");
    expect(r.detail).toContain("Test=success");
  });

  it("never treats a missing Gate as passed, even with every other check green", () => {
    for (const now of [0, 6 * MIN, 120 * MIN]) {
      const r = classifyGate({ ...base, checks: [gh("Test", "completed", "success")], now });
      expect(r.status).not.toBe("green");
    }
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

  it("is green only when every required check reported success", () => {
    const all = [gh("Gate", "completed", "success"), gh("Test", "completed", "success", 2)];
    expect(classifyGate({ ...base, checks: all, now: MIN }).status).toBe("green");
    for (const bad of [
      [gh("Gate", "completed", "success"), gh("Test", "completed", "neutral", 2)],
      [gh("Gate", "completed", "success"), gh("Test", "completed", "skipped", 2)],
      [gh("Gate", "completed", "success"), gh("Test", "completed", null, 2)],
      [gh("Gate", "completed", "success"), gh("Test", "queued", null, 2)],
    ]) {
      expect(classifyGate({ ...base, checks: bad, now: MIN }).status).not.toBe("green");
    }
  });

  it("blockers also refuse a merge unless every required check succeeded", () => {
    const snap = (checks: CheckStatus[]) =>
      computeBlockers({
        prOpen: true, prDraft: false, headSha: "a".repeat(40), shaRecordedByBroker: true, postHandoff: false,
        labels: [], pauseLabel: "p", stopLabel: "s", circuitBreakerTripped: false, mainTipGreen: true,
        branchUpToDateWithMain: true, protectedFilesTouched: [], requiredChecks: ["Gate", "Test"], checks,
        reviewsForHeadSha: [], requiredReviewers: [], mergeTreeClean: true, autoMergesToday: 0,
        maxAutoMergesPerDay: 3, shadowMode: false,
      }).map((b) => b.code);
    expect(snap([gh("Test", "completed", "success")])).toContain("check_missing");
    expect(snap([gh("Gate", "completed", "neutral"), gh("Test", "completed", "success", 2)])).toContain("check_failed");
  });

  it("a new head SHA supersedes the pending wait and resets the timer", () => {
    const phase: Phase = { kind: "awaiting_gate", prNumber: 10, headSha: "h1", baseSha: "b1", since: 0, nudgedAt: null };
    const meta = { issueNumber: 1, title: "Bug", needsYouLabel: "needs-you" };
    const res = stepPhase(
      phase,
      "autonomous",
      { t: "head_moved", pr: { prNumber: 10, headSha: "h2", baseSha: "b1" }, now: 59 * MIN },
      meta,
    );
    if (!res.ok) throw new Error(res.reject);
    expect(res.next).toMatchObject({ kind: "awaiting_gate", headSha: "h2", since: 59 * MIN });
    const after = res.next as Extract<Phase, { kind: "awaiting_gate" }>;
    const r = classifyGate({ ...base, checks: [], since: after.since, now: 60 * MIN });
    expect(r.status).toBe("missing_grace");
  });
});

describe("autonomy cap", () => {
  it("counts attempt starts and merges since the last owner audit row, per repo", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    try {
      ledger.upsertThread({ issueNumber: 1, title: "t", bodySha256: "x" });
      ledger.startAttempt(1, "implement");
      ledger.startAttempt(1, "revise");
      ledger.appendAudit("thread/merged", 1, "archangel", {});
      ledger.appendAudit("attempt/started", 9, "archangel", {}, Date.now(), "other/repo");
      ledger.appendAudit("thread/owner_retry", 9, "owner", {}, Date.now(), "other/repo");
      expect(ledger.autonomousStepsSinceOwner()).toBe(3);
      ledger.appendAudit("thread/owner_retry", 1, "owner", {});
      expect(ledger.autonomousStepsSinceOwner()).toBe(0);
      ledger.startAttempt(1, "rebase");
      expect(ledger.autonomousStepsSinceOwner()).toBe(1);
    } finally {
      ledger.close();
    }
  });

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
    fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), "{}\n");
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
