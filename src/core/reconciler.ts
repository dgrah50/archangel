import crypto from "node:crypto";
import type { ArchangelConfig } from "../config.js";
import type { Implementer, ImplementResult } from "../agents/implementer.js";
import type { ReviewerSuite } from "../agents/reviewers.js";
import { isProtectedPath, type GitBroker } from "../broker/git-broker.js";
import type { GitHubClient, GitHubIssue, GitHubPr } from "../github/client.js";
import type { ReviewFinding, ThreadRecord } from "../ledger/schema.js";
import type { Ledger } from "../ledger/store.js";
import { computeBlockers, isShadowReady } from "./blockers.js";
import type { Notifier } from "./notifier.js";
import { renderRecapComment } from "./recap.js";
import {
  buildImplementPrompt,
  buildRebasePrompt,
  buildRevisionPrompt,
} from "../agents/prompts.js";

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export interface ReconcilerDeps {
  config: ArchangelConfig;
  ledger: Ledger;
  github: GitHubClient;
  broker: GitBroker;
  implementer: Implementer;
  reviewers: ReviewerSuite;
  notifier: Notifier;
  workerId?: string;
}

/**
 * Level-triggered Reconciler (ADR-0005):
 * - GitHub owns owner intent (labels, PRs, checks).
 * - Ledger owns Thread state, leases, SHAs, reviews, spend & merge caps.
 * - Every tick converges open Threads idempotently, prioritizing in-progress resumes ahead of new intake.
 */
export class Reconciler {
  private readonly cfg: ArchangelConfig;
  private readonly ledger: Ledger;
  private readonly github: GitHubClient;
  private readonly broker: GitBroker;
  private readonly implementer: Implementer;
  private readonly reviewers: ReviewerSuite;
  private readonly notifier: Notifier;
  private readonly workerId: string;
  private readonly activeAborts = new Map<number, AbortController>();
  private readonly activeClones = new Map<number, string>();
  private readonly lastSummary = new Map<number, string>();

  constructor(deps: ReconcilerDeps) {
    this.cfg = deps.config;
    this.ledger = deps.ledger;
    this.github = deps.github;
    this.broker = deps.broker;
    this.implementer = deps.implementer;
    this.reviewers = deps.reviewers;
    this.notifier = deps.notifier;
    this.workerId = deps.workerId ?? `archangel-${process.pid}`;
  }

  getActiveAbort(issueNumber: number): AbortController | undefined {
    return this.activeAborts.get(issueNumber);
  }

  getActiveClone(issueNumber: number): string | undefined {
    return this.activeClones.get(issueNumber);
  }

  /**
   * Startup stale-run sweep before the first tick (recovers crashed/slept laptop runs).
   */
  startupSweep(now = Date.now()): number[] {
    return this.ledger.sweepStaleRuns(this.cfg.staleLeaseMs, now);
  }

  async tick(now = Date.now()): Promise<void> {
    const remoteUrl = await this.github.getRemoteUrlWithToken();
    await this.broker.ensureBareRepo(remoteUrl);
    const mainSha = await this.github.getBranchTipSha(this.cfg.defaultBranch);

    // 1. Monitor post-merge main CI health & circuit breaker (B8).
    await this.reconcilePostMergeMain(mainSha, remoteUrl);

    // 2. Intake eligible owner-authored, owner-labeled issues (B11).
    const readyIssues = await this.github.listOpenIssuesByLabel(this.cfg.labels.readyForAgent);
    const issueMap = new Map<number, GitHubIssue>();
    for (const issue of readyIssues) {
      issueMap.set(issue.number, issue);
      await this.reconcileIntakeIssue(issue, now);
    }

    // 3. Reconcile in-progress Threads FIRST (resumes ahead of new intake — Opus stampede fix).
    const allThreads = this.ledger.listThreads();
    const inProgress = allThreads.filter((t) =>
      ["awaiting_gate", "reviewing", "revising", "rebasing", "ready_to_land", "shadow_ready"].includes(
        t.state,
      ),
    );
    const queued = allThreads.filter((t) => t.state === "queued");

    let activeSlots = allThreads.filter((t) =>
      ["implementing", "revising", "rebasing", "reviewing"].includes(t.state),
    ).length;

    for (const thread of inProgress) {
      const issue = issueMap.get(thread.issueNumber);
      await this.reconcileThread(thread, issue, mainSha, remoteUrl, now);
    }

    for (const thread of queued) {
      if (activeSlots >= this.cfg.maxConcurrentThreads) break;
      const issue = issueMap.get(thread.issueNumber);
      if (!issue) continue;
      const started = await this.reconcileThread(thread, issue, mainSha, remoteUrl, now);
      if (started) activeSlots++;
    }
  }

  private async reconcileIntakeIssue(issue: GitHubIssue, now: number): Promise<void> {
    // ADR-0004 / B11: only owner-authored issues (verified by numeric user ID + OWNER association).
    if (issue.authorId !== this.cfg.ownerUserId || issue.authorAssociation !== "OWNER") {
      this.ledger.appendAudit("intake/rejected_untrusted_author", issue.number, issue.authorLogin, {
        authorId: issue.authorId,
        authorAssociation: issue.authorAssociation,
      });
      return;
    }

    const bodyHash = sha256(issue.body);
    const existing = this.ledger.getThread(issue.number);

    if (existing) {
      // Stop / pause label checks (GitHub owns owner intent).
      if (issue.labels.includes(this.cfg.labels.stop) && existing.state !== "stopped") {
        this.activeAborts.get(issue.number)?.abort();
        this.ledger.updateThread(issue.number, { state: "stopped", needsYouReason: "Stopped via factory:stop" }, now);
        return;
      }
      if (issue.labels.includes(this.cfg.labels.paused) && existing.state !== "paused") {
        this.activeAborts.get(issue.number)?.abort();
        this.ledger.updateThread(issue.number, { state: "paused" }, now);
        return;
      }
      if (issue.labels.includes(this.cfg.labels.disagree)) {
        this.ledger.markShadowDisagree(issue.number, true);
      }
      // Body edit TOCTOU check (B11).
      if (existing.bodySha256 !== bodyHash && existing.state !== "needs_you" && existing.state !== "merged") {
        await this.escalateNeedsYou(
          existing,
          "Issue body changed after intake snapshot (body hash mismatch); review before resuming.",
          now,
        );
      }
      return;
    }

    // Verify via timeline API that the owner applied `ready-for-agent` (B11).
    const ownerLabeled = await this.github.verifyLabelActor(
      issue.number,
      this.cfg.labels.readyForAgent,
      this.cfg.ownerUserId,
    );
    if (!ownerLabeled) {
      this.ledger.appendAudit("intake/rejected_label_actor", issue.number, "unknown", {
        label: this.cfg.labels.readyForAgent,
      });
      return;
    }

    const themeLabel = issue.labels.find((l) => l.startsWith("theme:")) ?? null;
    this.ledger.upsertThread({
      issueNumber: issue.number,
      repo: `${this.cfg.githubOwner}/${this.cfg.githubRepo}`,
      title: issue.title,
      themeLabel,
      bodySha256: bodyHash,
      state: "queued",
      now,
    });
  }

  private async reconcileThread(
    thread: ThreadRecord,
    issue: GitHubIssue | undefined,
    mainSha: string,
    remoteUrl: string,
    now: number,
  ): Promise<boolean> {
    if (["merged", "paused", "needs_you", "stopped", "failed"].includes(thread.state)) {
      return false;
    }
    if (!this.ledger.acquireLease(thread.issueNumber, this.workerId, this.cfg.staleLeaseMs, now)) {
      return false;
    }

    try {
      const fresh = this.ledger.getThread(thread.issueNumber)!;

      // Global stop / pause checks on PR too if PR exists.
      let pr: GitHubPr | null = fresh.prNumber ? await this.github.getPrLive(fresh.prNumber) : null;
      if (pr) {
        if (pr.labels.includes(this.cfg.labels.stop)) {
          this.ledger.updateThread(fresh.issueNumber, { state: "stopped" }, now);
          return false;
        }
        if (pr.labels.includes(this.cfg.labels.paused)) {
          this.ledger.updateThread(fresh.issueNumber, { state: "paused" }, now);
          return false;
        }
        if (pr.labels.includes(this.cfg.labels.disagree)) {
          this.ledger.markShadowDisagree(fresh.issueNumber, true);
        }
      }

      if (fresh.state === "queued") {
        if (!issue) return false;
        return await this.runImplementAttempt(fresh, issue, "implement", mainSha, remoteUrl, [], [], now);
      }

      if (fresh.state === "awaiting_gate") {
        if (!pr || !fresh.headSha) {
          await this.escalateNeedsYou(fresh, "Thread in awaiting_gate has no PR or head SHA.", now);
          return false;
        }
        await this.reconcileGateWait(fresh, pr, issue, mainSha, remoteUrl, now);
        return false;
      }

      if (fresh.state === "reviewing") {
        if (!pr || !fresh.headSha || !issue) return false;
        await this.runIndependentReviews(fresh, pr, issue, mainSha, now);
        return false;
      }

      if (fresh.state === "ready_to_land" || fresh.state === "shadow_ready") {
        if (!pr || !fresh.headSha) return false;
        await this.reconcileLanding(fresh, pr, issue, mainSha, remoteUrl, now);
        return false;
      }

      return false;
    } finally {
      this.ledger.releaseLease(thread.issueNumber, this.workerId);
    }
  }

  private async runImplementAttempt(
    thread: ThreadRecord,
    issue: GitHubIssue,
    kind: "implement" | "revise" | "rebase",
    mainSha: string,
    remoteUrl: string,
    gateViolations: string[],
    structuredFindings: Array<{ vendor: string; findings: ReviewFinding[] }>,
    now: number,
  ): Promise<boolean> {
    // Enforce daily USD spend cap (B9).
    const spentToday = this.ledger.getSpendToday(now);
    if (spentToday >= this.cfg.maxDailyUsd) {
      this.ledger.appendAudit("budget/daily_cap_reached", thread.issueNumber, "archangel", {
        spentToday,
        maxDailyUsd: this.cfg.maxDailyUsd,
      });
      return false;
    }

    // Enforce per-Thread total implement attempt cap (B9).
    if (thread.implementCount >= this.cfg.maxImplementAttemptsPerThread) {
      await this.escalateNeedsYou(
        thread,
        `Reached max implement attempts (${thread.implementCount}/${this.cfg.maxImplementAttemptsPerThread}).`,
        now,
      );
      return false;
    }

    const nextState = kind === "implement" ? "implementing" : kind === "revise" ? "revising" : "rebasing";
    this.ledger.updateThread(
      thread.issueNumber,
      {
        state: nextState,
        implementCount: thread.implementCount + 1,
        revisionCount: kind === "revise" ? thread.revisionCount + 1 : thread.revisionCount,
        rebaseCount: kind === "rebase" ? thread.rebaseCount + 1 : thread.rebaseCount,
      },
      now,
    );

    const attempt = this.ledger.startAttempt(thread.issueNumber, kind, now);
    const startRef = kind === "implement" ? mainSha : (thread.headSha ?? mainSha);
    const cloneDir = await this.broker.createThrowawayClone(thread.issueNumber, startRef);
    const abortController = new AbortController();
    this.activeClones.set(thread.issueNumber, cloneDir);
    this.activeAborts.set(thread.issueNumber, abortController);

    const prompt =
      kind === "implement"
        ? buildImplementPrompt({
            issueNumber: issue.number,
            title: issue.title,
            body: issue.body,
            repoName: `${this.cfg.githubOwner}/${this.cfg.githubRepo}`,
          })
        : kind === "revise"
          ? buildRevisionPrompt({
              issueNumber: issue.number,
              title: issue.title,
              body: issue.body,
              gateViolations,
              structuredFindings,
            })
          : buildRebasePrompt({
              issueNumber: issue.number,
              title: issue.title,
              baseBranch: this.cfg.defaultBranch,
            });

    const heartbeat = setInterval(() => {
      this.ledger.heartbeatLease(thread.issueNumber, this.workerId);
    }, 30_000);

    try {
      const result: ImplementResult = await this.implementer.run({
        issueNumber: issue.number,
        cloneDir,
        prompt,
        abortController,
        maxTurns: this.cfg.implementMaxTurns,
        timeoutMs: this.cfg.implementTimeoutMs,
        maxBudgetUsd: Math.max(0.5, this.cfg.maxDailyUsd - spentToday),
      });

      if (result.aborted) {
        this.ledger.finishAttempt(attempt.id, {
          status: "aborted",
          costUsd: result.costUsd,
          transcriptPath: result.transcriptPath,
          errorMessage: "Aborted (handoff or stop)",
        });
        return false;
      }

      // Hardened fetch + pre-push validation in Broker's bare clone (B2 + B4).
      const validation = await this.broker.fetchAndValidateFromClone(
        cloneDir,
        thread.issueNumber,
        mainSha,
      );

      if (validation.protectedViolations.length > 0) {
        this.ledger.finishAttempt(attempt.id, {
          status: "failed",
          headSha: validation.headSha,
          costUsd: result.costUsd,
          transcriptPath: result.transcriptPath,
          errorMessage: validation.protectedViolations.join("; "),
        });
        await this.escalateNeedsYou(
          this.ledger.getThread(thread.issueNumber)!,
          `Broker pre-push validation failed: ${validation.protectedViolations.join("; ")}`,
        );
        return false;
      }

      // Push strictly to factory/<issue> via GitHub App token.
      await this.broker.pushFactoryBranch(thread.branchName, validation.headSha, remoteUrl);
      this.ledger.recordPushedSha(validation.headSha, thread.issueNumber, "broker");

      // Idempotently create or reuse PR by head branch.
      const pr = await this.github.createPr({
        title: `fix(#${issue.number}): ${issue.title}`,
        body: `Closes #${issue.number}\n\nAutomated fix by Archangel.`,
        head: thread.branchName,
        base: this.cfg.defaultBranch,
      });

      this.lastSummary.set(thread.issueNumber, result.summary);
      this.ledger.finishAttempt(attempt.id, {
        status: "succeeded",
        headSha: validation.headSha,
        costUsd: result.costUsd,
        transcriptPath: result.transcriptPath,
      });
      const updated = this.ledger.updateThread(thread.issueNumber, {
        state: "awaiting_gate",
        prNumber: pr.number,
        headSha: validation.headSha,
        gateWaitStartedAt: Date.now(),
        gateRerunCount: 0,
      });

      await this.github.upsertRecapComment(
        pr.number,
        renderRecapComment({
          thread: updated,
          reviews: [],
          blockers: [{ code: "check_pending", message: "Waiting for required Gate & CI checks" }],
          summary: result.summary,
        }),
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ledger.finishAttempt(attempt.id, {
        status: "failed",
        errorMessage: msg,
      });
      await this.escalateNeedsYou(
        this.ledger.getThread(thread.issueNumber)!,
        `Implement attempt failed: ${msg}`,
      );
      return false;
    } finally {
      clearInterval(heartbeat);
      this.activeAborts.delete(thread.issueNumber);
      this.activeClones.delete(thread.issueNumber);
      this.broker.removeClone(cloneDir);
    }
  }

  private async reconcileGateWait(
    thread: ThreadRecord,
    pr: GitHubPr,
    issue: GitHubIssue | undefined,
    mainSha: string,
    remoteUrl: string,
    now: number,
  ): Promise<void> {
    const checks = await this.github.getCheckRunsForRef(thread.headSha!);
    const required = this.cfg.requiredChecks.map((name) => ({
      name,
      run: checks.find((c) => c.name === name),
    }));

    const waitMs = now - (thread.gateWaitStartedAt ?? thread.updatedAt);

    // Gate never started after grace period -> escalate or rerun once.
    const missing = required.filter((r) => !r.run);
    if (missing.length > 0) {
      if (waitMs > this.cfg.gateTimeoutMs) {
        await this.escalateNeedsYou(
          thread,
          `Required checks did not complete within timeout (${missing.map((m) => m.name).join(", ")}).`,
          now,
        );
      } else if (waitMs > this.cfg.gateStartGraceMs && thread.gateRerunCount === 0) {
        this.ledger.updateThread(thread.issueNumber, { gateRerunCount: 1 }, now);
        this.ledger.appendAudit("gate/grace_exceeded", thread.issueNumber, "archangel", {
          missing: missing.map((m) => m.name),
        });
      }
      return;
    }

    if (required.some((r) => r.run!.status !== "completed")) {
      if (waitMs > this.cfg.gateTimeoutMs) {
        await this.escalateNeedsYou(thread, "Required checks timed out after 1h.", now);
      }
      return;
    }

    // Check untrusted app sources on required checks (B4).
    const untrusted = required.filter(
      (r) => r.run!.appSlug && r.run!.appSlug !== "github-actions",
    );
    if (untrusted.length > 0) {
      await this.escalateNeedsYou(
        thread,
        `Untrusted check source for ${untrusted.map((u) => u.name).join(", ")}`,
        now,
      );
      return;
    }

    const failed = required.filter((r) => r.run!.conclusion !== "success");
    if (failed.length > 0) {
      // One automatic revision attempt on Gate/CI failure.
      if (issue && thread.revisionCount < this.cfg.maxRevisionsPerThread) {
        await this.runImplementAttempt(
          thread,
          issue,
          "revise",
          mainSha,
          remoteUrl,
          failed.map((f) => `${f.name}: ${f.run!.conclusion ?? "failed"}`),
          [],
          now,
        );
      } else {
        await this.escalateNeedsYou(
          thread,
          `Required checks failed after max revisions: ${failed.map((f) => f.name).join(", ")}`,
          now,
        );
      }
      return;
    }

    // All required checks green -> advance to independent cross-vendor review!
    const updated = this.ledger.updateThread(thread.issueNumber, { state: "reviewing" }, now);
    if (issue) {
      await this.runIndependentReviews(updated, pr, issue, mainSha, now);
    }
  }

  private async runIndependentReviews(
    thread: ThreadRecord,
    pr: GitHubPr,
    issue: GitHubIssue,
    mainSha: string,
    now: number,
  ): Promise<void> {
    const headSha = thread.headSha!;
    const existing = this.ledger.getReviewsForSha(thread.issueNumber, headSha);
    const haveOpenAi = existing.some((r) => r.vendor === "openai");
    const haveGemini = existing.some((r) => r.vendor === "gemini");

    if (!haveOpenAi || !haveGemini) {
      // Load diff & full touched files directly from Broker bare repo (no agent-writable checkout).
      const { diffText, touchedFiles } = await this.broker
        .getDiffAndTouchedFiles(mainSha, headSha)
        .catch(() => ({ diffText: "", touchedFiles: {} as Record<string, string> }));

      try {
        const results = await this.reviewers.reviewAll({
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body,
          headSha,
          diffText,
          touchedFiles,
          skipVendors: [
            ...(haveOpenAi ? (["openai"] as const) : []),
            ...(haveGemini ? (["gemini"] as const) : []),
          ],
        });

        for (const r of results) {
          // Runtime records the SHA it fed — never trust a model-echoed SHA (B7).
          this.ledger.recordReview({
            issueNumber: thread.issueNumber,
            headSha,
            vendor: r.vendor,
            verdict: r.verdict,
            findings: r.findings,
            costUsd: r.costUsd,
            now,
          });
        }
        this.ledger.updateThread(thread.issueNumber, { reviewOutageStartedAt: null }, now);
      } catch (err) {
        // Outage backoff with 6h limit -> Needs You (never bypass quorum).
        const outageStart = thread.reviewOutageStartedAt ?? now;
        this.ledger.updateThread(thread.issueNumber, { reviewOutageStartedAt: outageStart }, now);
        if (now - outageStart >= this.cfg.reviewerOutageMaxMs) {
          await this.escalateNeedsYou(
            thread,
            `Reviewer vendor unavailable for >6h: ${err instanceof Error ? err.message : String(err)}`,
            now,
          );
        }
        return;
      }
    }

    const reviews = this.ledger.getReviewsForSha(thread.issueNumber, headSha);
    const vetoes = reviews.filter((r) => r.verdict !== "approve");

    if (vetoes.length > 0) {
      const structuredFindings = vetoes.map((v) => ({
        vendor: v.vendor,
        findings: JSON.parse(v.findingsJson) as ReviewFinding[],
      }));

      if (thread.revisionCount < this.cfg.maxRevisionsPerThread) {
        const remoteUrl = await this.github.getRemoteUrlWithToken();
        await this.runImplementAttempt(
          thread,
          issue,
          "revise",
          mainSha,
          remoteUrl,
          [],
          structuredFindings,
          now,
        );
      } else {
        await this.escalateNeedsYou(
          thread,
          `Independent reviewer vetoed ${headSha.slice(0, 8)} (${vetoes.map((v) => v.vendor).join(", ")}).`,
          now,
        );
      }
      return;
    }

    // Both independent vendors approved -> proceed to Lander evaluation.
    const ready = this.ledger.updateThread(thread.issueNumber, { state: "ready_to_land" }, now);
    const remoteUrl = await this.github.getRemoteUrlWithToken();
    await this.reconcileLanding(ready, pr, issue, mainSha, remoteUrl, now);
  }

  private async reconcileLanding(
    thread: ThreadRecord,
    _stalePr: GitHubPr,
    issue: GitHubIssue | undefined,
    mainSha: string,
    remoteUrl: string,
    now: number,
  ): Promise<void> {
    // Live re-read right before merge (B7 TOCTOU defense).
    const pr = await this.github.getPrLive(thread.prNumber!);
    const checks = await this.github.getCheckRunsForRef(pr.headSha);
    const mainChecks = await this.github.getCheckRunsForRef(mainSha);
    const mainTipGreen =
      mainChecks.length === 0 ||
      mainChecks
        .filter((c) => c.name.startsWith("Test ("))
        .every((c) => c.status === "completed" && c.conclusion === "success");

    const shaInfo = this.ledger.isKnownSha(thread.issueNumber, pr.headSha);
    const protectedFilesTouched = pr.changedFiles.filter((f) => isProtectedPath(f));
    const mergeTreeClean = await this.broker.isMergeTreeClean(mainSha, pr.headSha);
    const reviews = this.ledger.getReviewsForSha(thread.issueNumber, pr.headSha);
    const cb = this.ledger.getCircuitBreaker();

    const blockers = computeBlockers({
      prOpen: pr.state === "open",
      prDraft: pr.draft,
      headSha: pr.headSha,
      shaRecordedByBroker: shaInfo.known && shaInfo.origin === "broker",
      postHandoff: thread.postHandoff,
      labels: [...new Set([...pr.labels, ...(issue?.labels ?? [])])],
      pauseLabel: this.cfg.labels.paused,
      stopLabel: this.cfg.labels.stop,
      circuitBreakerTripped: cb.tripped,
      mainTipGreen,
      branchUpToDateWithMain: pr.baseSha === mainSha || mergeTreeClean,
      protectedFilesTouched,
      requiredChecks: this.cfg.requiredChecks,
      checks,
      reviewsForHeadSha: reviews,
      requiredReviewers: ["openai", "gemini"],
      mergeTreeClean,
      autoMergesToday: this.ledger.getAutoMergeCountToday(now),
      maxAutoMergesPerDay: this.cfg.maxAutoMergesPerDay,
      shadowMode: this.cfg.shadowMode,
    });

    // Handle merge conflicts with 1 automated rebase Attempt.
    if (blockers.some((b) => b.code === "merge_conflict")) {
      if (issue && thread.rebaseCount < this.cfg.maxRebasesPerThread) {
        await this.runImplementAttempt(thread, issue, "rebase", mainSha, remoteUrl, [], [], now);
        return;
      }
      await this.escalateNeedsYou(thread, "Merge conflict persists after automated rebase attempt.", now);
      return;
    }

    // Shadow Mode: ready except for shadow_mode_active.
    if (isShadowReady(blockers)) {
      if (thread.state !== "shadow_ready") {
        const updated = this.ledger.updateThread(thread.issueNumber, { state: "shadow_ready" }, now);
        this.ledger.recordMerge({
          issueNumber: thread.issueNumber,
          prNumber: pr.number,
          headSha: pr.headSha,
          shadowOnly: true,
          now,
        });
        await this.github.upsertRecapComment(
          pr.number,
          renderRecapComment({
            thread: updated,
            reviews,
            blockers,
            wouldMerge: true,
            summary: this.lastSummary.get(thread.issueNumber),
          }),
        );
      }
      return;
    }

    if (blockers.length > 0) {
      await this.github.upsertRecapComment(
        pr.number,
        renderRecapComment({
          thread,
          reviews,
          blockers,
          summary: this.lastSummary.get(thread.issueNumber),
        }),
      );
      return;
    }

    // All blockers empty -> squash merge pinned strictly to approved head SHA (B7).
    const { squashSha } = await this.github.squashMergePr(
      pr.number,
      pr.headSha,
      `fix(#${thread.issueNumber}): ${thread.title} (#${pr.number})`,
    );
    const merged = this.ledger.updateThread(thread.issueNumber, { state: "merged" }, now);
    this.ledger.recordMerge({
      issueNumber: thread.issueNumber,
      prNumber: pr.number,
      headSha: pr.headSha,
      squashSha,
      shadowOnly: false,
      now,
    });
    await this.github.upsertRecapComment(
      pr.number,
      renderRecapComment({
        thread: merged,
        reviews,
        blockers: [],
        summary: `Squash-merged into \`${this.cfg.defaultBranch}\` at \`${squashSha.slice(0, 10)}\`.`,
      }),
    );
  }

  /**
   * Post-merge main health monitoring + global circuit breaker + exact-inverse revert PR (B8).
   */
  private async reconcilePostMergeMain(mainSha: string, remoteUrl: string): Promise<void> {
    const pending = this.ledger.listPendingPostMergeChecks();
    if (pending.length === 0) return;

    for (const m of pending) {
      if (!m.squashSha) continue;
      const checks = await this.github.getCheckRunsForRef(m.squashSha);
      const ciRuns = checks.filter((c) => c.name.startsWith("Test ("));
      if (ciRuns.length === 0 || ciRuns.some((c) => c.status !== "completed")) {
        continue;
      }
      const failed = ciRuns.filter((c) => c.conclusion !== "success");
      if (failed.length === 0) {
        this.ledger.updateMergeMainStatus(m.id, "green");
        continue;
      }

      // Re-run once to rule out flakes before tripping circuit breaker / reverting (B8).
      if (m.mainStatus === "pending") {
        for (const f of failed) {
          await this.github.rerunCheckRun(f.id);
        }
        this.ledger.updateMergeMainStatus(m.id, "rerun_once");
        continue;
      }

      // Confirmed red main on factory squash SHA -> trip global circuit breaker!
      this.ledger.setCircuitBreaker(
        true,
        `main CI failed on factory squash ${m.squashSha.slice(0, 10)} (issue #${m.issueNumber})`,
      );

      // Only auto-open an exact-inverse revert PR if this merge is still the tip of main (clear attribution).
      if (mainSha === m.squashSha) {
        const rev = await this.broker.createExactRevertBranch(m.issueNumber, mainSha, m.squashSha);
        await this.broker.pushFactoryBranch(rev.branchName, rev.headSha, remoteUrl);
        const revertPr = await this.github.createPr({
          title: `revert(#${m.issueNumber}): revert ${m.squashSha.slice(0, 8)} after red main`,
          body: `Automated exact-inverse revert of ${m.squashSha} (PR #${m.prNumber}) after confirmed CI failure on \`${this.cfg.defaultBranch}\`.\n\nGlobal landing circuit breaker is now **TRIPPED**.`,
          head: rev.branchName,
          base: this.cfg.defaultBranch,
        });
        this.ledger.updateMergeMainStatus(m.id, "red_reverted", revertPr.number);
        await this.notifier.notifyNeedsYou({
          issueNumber: m.issueNumber,
          title: `Red main after merge of PR #${m.prNumber}`,
          reason: `Circuit breaker tripped and exact-inverse revert PR #${revertPr.number} opened.`,
        });
      } else {
        this.ledger.updateMergeMainStatus(m.id, "red_escalated");
        await this.notifier.notifyNeedsYou({
          issueNumber: m.issueNumber,
          title: `Red main on ${m.squashSha.slice(0, 8)} (multiple merges interleaved)`,
          reason: "Circuit breaker tripped; manual revert needed because main has moved.",
        });
      }
    }
  }

  private async escalateNeedsYou(
    thread: ThreadRecord,
    reason: string,
    now = Date.now(),
  ): Promise<void> {
    const updated = this.ledger.updateThread(
      thread.issueNumber,
      { state: "needs_you", needsYouReason: reason },
      now,
    );
    this.ledger.appendAudit("thread/needs_you", thread.issueNumber, "archangel", { reason });
    await this.github.addLabels(thread.issueNumber, [this.cfg.labels.needsYou]);
    if (updated.prNumber) {
      await this.github.upsertRecapComment(
        updated.prNumber,
        renderRecapComment({
          thread: updated,
          reviews: updated.headSha
            ? this.ledger.getReviewsForSha(updated.issueNumber, updated.headSha)
            : [],
          blockers: [{ code: "paused", message: reason }],
        }),
      );
    }
    await this.notifier.notifyNeedsYou({
      issueNumber: thread.issueNumber,
      title: thread.title,
      reason,
    });
  }
}
