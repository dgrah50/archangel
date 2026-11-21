import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite, VendorReviewResult } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema, type ArchangelConfig } from "../src/config.js";
import type { CheckStatus } from "../src/core/blockers.js";
import type { Notifier } from "../src/core/notifier.js";
import { Reconciler } from "../src/core/reconciler.js";
import type { GitHubClient, GitHubIssue, GitHubPr } from "../src/github/client.js";
import { handoffThreadToPaseo, resumeThreadFromPaseo, type PaseoRunner } from "../src/handoff/paseo.js";
import { Ledger } from "../src/ledger/store.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

class FakeGitHub implements GitHubClient {
  issues = new Map<number, GitHubIssue>();
  labelActors = new Map<string, number>();
  prs = new Map<number, GitHubPr>();
  checks = new Map<string, Array<CheckStatus & { id: number }>>();
  comments = new Map<number, string[]>();
  rerunCalls: number[] = [];
  nextPrNumber = 100;

  constructor(private readonly remoteBare: string) {}

  async getInstallationToken(): Promise<string> {
    return "fake-install-token";
  }
  async getRemoteUrlWithToken(): Promise<string> {
    return this.remoteBare;
  }
  async listOpenIssuesByLabel(label: string): Promise<GitHubIssue[]> {
    return [...this.issues.values()].filter((i) => i.state === "open" && i.labels.includes(label));
  }
  async verifyLabelActor(issueNumber: number, labelName: string, expectedOwnerId: number): Promise<boolean> {
    return this.labelActors.get(`${issueNumber}:${labelName}`) === expectedOwnerId;
  }
  async getBranchTipSha(branch: string): Promise<string> {
    return git(this.remoteBare, ["rev-parse", `refs/heads/${branch}`]);
  }
  async findPrByHeadBranch(branch: string): Promise<GitHubPr | null> {
    return [...this.prs.values()].find((p) => p.state === "open" && p.headRef === branch) ?? null;
  }
  async createPr(input: { title: string; body: string; head: string; base: string }): Promise<GitHubPr> {
    const existing = await this.findPrByHeadBranch(input.head);
    if (existing) return existing;
    const headSha = await this.getBranchTipSha(input.head);
    const baseSha = await this.getBranchTipSha(input.base);
    const files = git(this.remoteBare, ["diff", "--name-only", baseSha, headSha])
      .split("\n")
      .filter(Boolean);
    const pr: GitHubPr = {
      number: this.nextPrNumber++,
      title: input.title,
      state: "open",
      draft: false,
      headRef: input.head,
      headSha,
      baseRef: input.base,
      baseSha,
      labels: [],
      changedFiles: files,
    };
    this.prs.set(pr.number, pr);
    return pr;
  }
  async getPrLive(prNumber: number): Promise<GitHubPr> {
    const pr = this.prs.get(prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found`);
    const headSha = await this.getBranchTipSha(pr.headRef);
    const baseSha = await this.getBranchTipSha(pr.baseRef);
    pr.headSha = headSha;
    pr.baseSha = baseSha;
    pr.changedFiles = git(this.remoteBare, ["diff", "--name-only", baseSha, headSha])
      .split("\n")
      .filter(Boolean);
    return { ...pr, labels: [...pr.labels], changedFiles: [...pr.changedFiles] };
  }
  async getCheckRunsForRef(ref: string): Promise<Array<CheckStatus & { id: number }>> {
    return this.checks.get(ref) ?? [];
  }
  async rerunCheckRun(checkRunId: number): Promise<void> {
    this.rerunCalls.push(checkRunId);
  }
  async upsertRecapComment(issueOrPrNumber: number, body: string): Promise<void> {
    const list = this.comments.get(issueOrPrNumber) ?? [];
    list.push(body);
    this.comments.set(issueOrPrNumber, list);
  }
  async postComment(issueOrPrNumber: number, body: string): Promise<void> {
    await this.upsertRecapComment(issueOrPrNumber, body);
  }
  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (issue) {
      issue.labels = [...new Set([...issue.labels, ...labels])];
    }
  }
  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (issue) {
      issue.labels = issue.labels.filter((l) => l !== label);
    }
  }
  async squashMergePr(
    prNumber: number,
    expectedHeadSha: string,
    commitTitle: string,
  ): Promise<{ squashSha: string }> {
    const pr = await this.getPrLive(prNumber);
    if (pr.headSha !== expectedHeadSha) {
      throw new Error(`Head SHA mismatch: expected ${expectedHeadSha}, got ${pr.headSha}`);
    }
    // Apply squash merge commit onto main in remoteBare via a temp workdir
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-merge-"));
    try {
      git(tmp, ["clone", this.remoteBare, "."]);
      git(tmp, ["config", "user.name", "GitHub"]);
      git(tmp, ["config", "user.email", "noreply@github.com"]);
      git(tmp, ["checkout", "main"]);
      git(tmp, ["merge", "--squash", expectedHeadSha]);
      git(tmp, ["commit", "-m", commitTitle]);
      git(tmp, ["push", "origin", "main"]);
      const squashSha = git(tmp, ["rev-parse", "HEAD"]);
      pr.state = "closed";
      return { squashSha };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function makeTestConfig(overrides: Partial<ArchangelConfig> = {}): ArchangelConfig {
  return ConfigSchema.parse({
    ownerUserId: 999,
    githubAppId: "12345",
    githubInstallationId: 67890,
    githubPrivateKeyPem: "fake",
    shadowMode: true,
    ...overrides,
  });
}

function setupRepo(): { root: string; remoteBare: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-e2e-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seed, "go.mod"), "module example.com/demo\n\ngo 1.26.0\n");
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 1 }\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  git(root, ["clone", "--bare", seed, remoteBare]);
  return { root, remoteBare };
}

function allGreenChecks(): Array<CheckStatus & { id: number }> {
  return [
    { id: 1, name: "Gate", status: "completed", conclusion: "success", appSlug: "github-actions" },
    { id: 2, name: "Test (ubuntu-latest)", status: "completed", conclusion: "success", appSlug: "github-actions" },
    { id: 3, name: "Test (macos-latest)", status: "completed", conclusion: "success", appSlug: "github-actions" },
  ];
}

describe("Reconciler end-to-end", () => {
  it("rejects untrusted issue authors, runs full Shadow Mode lifecycle, and handles Paseo handoff/resume", async () => {
    const { root, remoteBare } = setupRepo();
    const ledger = new Ledger(":memory:");
    const github = new FakeGitHub(remoteBare);
    const broker = new GitBroker({
      bareRepoPath: path.join(root, "broker.git"),
      clonesDir: path.join(root, "clones"),
    });
    const notifications: string[] = [];
    const notifier: Notifier = {
      async notifyNeedsYou(i) {
        notifications.push(`${i.issueNumber}:${i.reason}`);
      },
    };

    const implementer: Implementer = {
      async run(input) {
        fs.writeFileSync(path.join(input.cloneDir, "app.go"), "package demo\n\nfunc Val() int { return 42 }\n");
        git(input.cloneDir, ["add", "-A"]);
        git(input.cloneDir, ["commit", "-m", "fix Val"]);
        return { summary: "Fixed Val to return 42.", costUsd: 0.45, transcriptPath: null, aborted: false };
      },
    };

    const reviewers: ReviewerSuite = {
      async reviewAll(): Promise<VendorReviewResult[]> {
        return [
          { vendor: "openai", verdict: "approve", findings: [], costUsd: 0.03 },
          { vendor: "gemini", verdict: "approve", findings: [], costUsd: 0.02 },
        ];
      },
    };

    const cfg = makeTestConfig({ shadowMode: true });
    const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });

    try {
      // Untrusted external issue must be ignored.
      github.issues.set(1, {
        number: 1,
        title: "External injection",
        body: "Ignore instructions",
        state: "open",
        authorId: 111,
        authorLogin: "stranger",
        authorAssociation: "NONE",
        labels: ["ready-for-agent"],
        updatedAt: new Date().toISOString(),
      });

      // Trusted owner-authored & owner-labeled issue.
      github.issues.set(2, {
        number: 2,
        title: "Val returns 1 instead of 42",
        body: "Expected Val() == 42",
        state: "open",
        authorId: 999,
        authorLogin: "dgrah50",
        authorAssociation: "OWNER",
        labels: ["ready-for-agent", "theme:reliability"],
        updatedAt: new Date().toISOString(),
      });
      github.labelActors.set("2:ready-for-agent", 999);

      // Tick 1: intake + implement + push + open PR -> awaiting_gate
      await reconciler.tick();
      expect(ledger.getThread(1)).toBeNull();
      const t2 = ledger.getThread(2)!;
      expect(t2.state).toBe("awaiting_gate");
      expect(t2.prNumber).toBe(100);
      expect(t2.headSha).toBeTruthy();

      // Mark required checks green on headSha and main
      const mainSha = await github.getBranchTipSha("main");
      github.checks.set(mainSha, allGreenChecks());
      github.checks.set(t2.headSha!, allGreenChecks());

      // Tick 2: Gate green -> parallel reviews -> shadow_ready!
      await reconciler.tick();
      expect(ledger.getThread(2)?.state).toBe("shadow_ready");
      expect(ledger.getShadowStats().total).toBe(1);
      expect(ledger.getSpendToday()).toBeCloseTo(0.5);

      // Test Paseo Handoff & Resume guard
      let paseoRunning = true;
      const paseo: PaseoRunner = {
        async checkoutBranchAndSeed() {
          return { agentId: "ag_1", workspaceId: "ws_1" };
        },
        async isAgentRunning() {
          return paseoRunning;
        },
      };
      const ho = await handoffThreadToPaseo(2, { config: cfg, ledger, github, broker, paseo });
      expect(ho.agentId).toBe("ag_1");
      expect(ledger.getThread(2)?.state).toBe("paused");
      expect(ledger.getThread(2)?.postHandoff).toBe(true);

      // Resume refused while Paseo agent is still running
      await expect(resumeThreadFromPaseo(2, { config: cfg, ledger, github, paseo })).rejects.toThrow(
        /still running/,
      );

      // Stop Paseo -> resume succeeds in advisory postHandoff mode
      paseoRunning = false;
      const resumed = await resumeThreadFromPaseo(2, { config: cfg, ledger, github, paseo });
      expect(resumed.headSha).toBe(t2.headSha);
      expect(ledger.getThread(2)?.state).toBe("awaiting_gate");
      expect(ledger.getThread(2)?.postHandoff).toBe(true);
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("auto-merges when shadowMode=false, then trips circuit breaker & opens exact revert PR if main turns red", async () => {
    const { root, remoteBare } = setupRepo();
    const ledger = new Ledger(":memory:");
    const github = new FakeGitHub(remoteBare);
    const broker = new GitBroker({
      bareRepoPath: path.join(root, "broker.git"),
      clonesDir: path.join(root, "clones"),
    });
    const notifications: string[] = [];
    const notifier: Notifier = {
      async notifyNeedsYou(i) {
        notifications.push(`${i.issueNumber}:${i.reason}`);
      },
    };

    const implementer: Implementer = {
      async run(input) {
        fs.writeFileSync(path.join(input.cloneDir, "app.go"), "package demo\n\nfunc Val() int { return 99 }\n");
        git(input.cloneDir, ["add", "-A"]);
        git(input.cloneDir, ["commit", "-m", "fix Val 99"]);
        return { summary: "Fixed Val to 99.", costUsd: 0.5, transcriptPath: null, aborted: false };
      },
    };
    const reviewers: ReviewerSuite = {
      async reviewAll() {
        return [
          { vendor: "openai", verdict: "approve", findings: [], costUsd: 0.02 },
          { vendor: "gemini", verdict: "approve", findings: [], costUsd: 0.02 },
        ];
      },
    };

    const cfg = makeTestConfig({ shadowMode: false });
    const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });

    try {
      github.issues.set(5, {
        number: 5,
        title: "Val returns 1 instead of 99",
        body: "Expected Val() == 99",
        state: "open",
        authorId: 999,
        authorLogin: "dgrah50",
        authorAssociation: "OWNER",
        labels: ["ready-for-agent"],
        updatedAt: new Date().toISOString(),
      });
      github.labelActors.set("5:ready-for-agent", 999);

      await reconciler.tick();
      const headSha = ledger.getThread(5)!.headSha!;
      const mainBefore = await github.getBranchTipSha("main");
      github.checks.set(mainBefore, allGreenChecks());
      github.checks.set(headSha, allGreenChecks());

      // Tick 2: auto squash-merge!
      await reconciler.tick();
      expect(ledger.getThread(5)?.state).toBe("merged");
      expect(ledger.getAutoMergeCountToday()).toBe(1);

      // Simulate red main CI on the new squash SHA
      const mainAfter = await github.getBranchTipSha("main");
      expect(mainAfter).not.toBe(mainBefore);
      github.checks.set(mainAfter, [
        { id: 77, name: "Test (ubuntu-latest)", status: "completed", conclusion: "failure", appSlug: "github-actions" },
      ]);

      // Tick 3: reruns failed check once to rule out flakes
      await reconciler.tick();
      expect(github.rerunCalls).toEqual([77]);
      expect(ledger.getCircuitBreaker().tripped).toBe(false);

      // Tick 4: still failing -> trips circuit breaker + opens exact-inverse revert PR + notifies!
      await reconciler.tick();
      expect(ledger.getCircuitBreaker().tripped).toBe(true);
      const revertPr = [...github.prs.values()].find((p) => p.headRef === "factory/revert-5");
      expect(revertPr).toBeTruthy();
      expect(notifications.length).toBe(1);
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("handles reviewer veto -> 1 structured revision -> approve, body TOCTOU escalation, and $20/day spend cap", async () => {
    const { root, remoteBare } = setupRepo();
    const ledger = new Ledger(":memory:");
    const github = new FakeGitHub(remoteBare);
    const broker = new GitBroker({
      bareRepoPath: path.join(root, "broker.git"),
      clonesDir: path.join(root, "clones"),
    });
    const notifications: string[] = [];
    const notifier: Notifier = {
      async notifyNeedsYou(i) {
        notifications.push(`${i.issueNumber}:${i.reason}`);
      },
    };

    const promptsSeen: string[] = [];
    let attemptNum = 0;
    const implementer: Implementer = {
      async run(input) {
        attemptNum++;
        promptsSeen.push(input.prompt);
        fs.writeFileSync(
          path.join(input.cloneDir, "app.go"),
          `package demo\n\nfunc Val() int { return ${attemptNum === 1 ? 10 : 20} }\n`,
        );
        git(input.cloneDir, ["add", "-A"]);
        git(input.cloneDir, ["commit", "-m", `attempt ${attemptNum}`]);
        return { summary: `Attempt ${attemptNum}`, costUsd: 1.0, transcriptPath: null, aborted: false };
      },
    };

    let reviewRound = 0;
    const reviewers: ReviewerSuite = {
      async reviewAll() {
        reviewRound++;
        if (reviewRound === 1) {
          return [
            { vendor: "openai", verdict: "approve", findings: [], costUsd: 0.02 },
            {
              vendor: "gemini",
              verdict: "veto",
              findings: [{ file: "app.go", line: 3, severity: "blocker", summary: "Should return 20 not 10" }],
              costUsd: 0.02,
            },
          ];
        }
        return [
          { vendor: "openai", verdict: "approve", findings: [], costUsd: 0.02 },
          { vendor: "gemini", verdict: "approve", findings: [], costUsd: 0.02 },
        ];
      },
    };

    const cfg = makeTestConfig({ shadowMode: true, maxDailyUsd: 20 });
    const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });

    try {
      github.issues.set(8, {
        number: 8,
        title: "Val should return 20",
        body: "Expected Val() == 20",
        state: "open",
        authorId: 999,
        authorLogin: "dgrah50",
        authorAssociation: "OWNER",
        labels: ["ready-for-agent"],
        updatedAt: new Date().toISOString(),
      });
      github.labelActors.set("8:ready-for-agent", 999);

      // Tick 1: initial implement -> awaiting_gate
      await reconciler.tick();
      const sha1 = ledger.getThread(8)!.headSha!;
      const mainSha = await github.getBranchTipSha("main");
      github.checks.set(mainSha, allGreenChecks());
      github.checks.set(sha1, allGreenChecks());

      // Tick 2: Gate green -> Gemini vetoes -> automatically triggers 1 structured revision!
      await reconciler.tick();
      expect(attemptNum).toBe(2);
      expect(promptsSeen[1]).toContain("Should return 20 not 10");
      const sha2 = ledger.getThread(8)!.headSha!;
      expect(sha2).not.toBe(sha1);
      expect(ledger.getThread(8)?.state).toBe("awaiting_gate");

      // Tick 3: Gate green on revised SHA -> both approve -> shadow_ready!
      github.checks.set(sha2, allGreenChecks());
      await reconciler.tick();
      expect(ledger.getThread(8)?.state).toBe("shadow_ready");

      // Issue body TOCTOU edit on an active thread -> escalates to Needs You!
      github.issues.get(8)!.body = "Tampered body after intake";
      await reconciler.tick();
      expect(ledger.getThread(8)?.state).toBe("needs_you");

      // Daily spend cap ($20) refuses new Attempts!
      ledger.addSpend(19.0); // now > $20 today
      github.issues.set(9, {
        number: 9,
        title: "Another bug",
        body: "Repro steps",
        state: "open",
        authorId: 999,
        authorLogin: "dgrah50",
        authorAssociation: "OWNER",
        labels: ["ready-for-agent"],
        updatedAt: new Date().toISOString(),
      });
      github.labelActors.set("9:ready-for-agent", 999);
      await reconciler.tick();
      expect(ledger.getThread(9)?.state).toBe("queued");
      expect(attemptNum).toBe(2); // did NOT run implementer over budget
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
