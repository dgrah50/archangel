import crypto from "node:crypto";
import { mergeLandingJson, type ArchangelConfig, type GatePolicy } from "../config.js";
import type { Implementer, ImplementResult } from "../agents/implementer.js";
import {
  buildImplementPrompt,
  buildRebasePrompt,
  buildRevisionPrompt,
} from "../agents/prompts.js";
import type { ReviewerSuite } from "../agents/reviewers.js";
import { isProtectedPath, type GitBroker } from "../broker/git-broker.js";
import type { GitHubClient, GitHubIssue, GitHubPr } from "../github/client.js";
import type { MergeRecord, ReviewFinding, ThreadRecord } from "../ledger/schema.js";
import type { Ledger } from "../ledger/store.js";
import { computeBlockers, isShadowReady } from "./blockers.js";
import type { Notifier } from "./notifier.js";
import { renderRecapComment } from "./recap.js";
import {
  classifyGate,
  deriveControl,
  extractPrFromPhase,
  stepPhase,
  type AttemptKind,
  type EscalationCode,
  type MachineEvent,
  type MainWatch,
  type PrRef,
} from "./thread-machine.js";

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

interface RunningTask {
  issueNumber: number;
  attemptId: number;
  abortController: AbortController;
  abortCause: "timeout" | "control" | "handoff" | null;
  cloneDir: string;
  promise: Promise<void>;
}

const POST_MERGE_WATCH_TIMEOUT_MS = 2 * 60 * 60_000;
const REVIEW_RESERVATION_USD = 0.25;

/**
 * Level-triggered Reconciler (ADR-0005 + Opus State-Machine Refactor + Codex Fail-Closed Fixes):
 * - Non-overlapping tick guard + single-flight background attempt runner (`runningTasks`).
 * - All state writes go through `stepPhase()` + compare-and-set `Ledger.transition()` + durable `outbox`.
 * - Owner Control (`run | paused | stopped`) is derived fresh from GitHub labels every tick.
 * - Mode (`autonomous | advisory`) structurally prevents factory attempts after Handoff.
 */
export class Reconciler {
  private readonly cfg: ArchangelConfig;
  private readonly ledger: Ledger;
  private readonly github: GitHubClient;
  private readonly broker: GitBroker;
  private readonly implementer: Implementer;
  private readonly reviewers: ReviewerSuite;
  private readonly notifier: Notifier;
  readonly workerId: string;

  private isTicking = false;
  private readonly runningTasks = new Map<number, RunningTask>();
  private readonly rejectedIssueCache = new Map<number, string>(); // issueNumber -> updatedAt
  private effectiveGate: GatePolicy;
  private effectiveRequiredChecks: string[];
  private effectiveReviewRubric: string | undefined;

  constructor(deps: ReconcilerDeps) {
    this.cfg = deps.config;
    this.ledger = deps.ledger.forRepo(`${deps.config.githubOwner}/${deps.config.githubRepo}`);
    this.github = deps.github;
    this.broker = deps.broker;
    this.implementer = deps.implementer;
    this.reviewers = deps.reviewers;
    this.notifier = deps.notifier;
    this.workerId = deps.workerId ?? `archangel-${process.pid}`;
    this.effectiveGate = deps.config.gate;
    this.effectiveRequiredChecks = deps.config.requiredChecks;
    this.effectiveReviewRubric = deps.config.reviewRubric;
  }

  activeTaskCount(): number {
    return this.runningTasks.size;
  }

  /** Waits for all in-flight background attempts to settle (useful for `--once`, shutdown, and tests). */
  async waitForActiveTasks(): Promise<void> {
    while (this.runningTasks.size > 0) {
      await Promise.allSettled([...this.runningTasks.values()].map((t) => t.promise));
    }
  }

  abortAllActive(cause: "control" | "handoff" = "control"): void {
    for (const task of this.runningTasks.values()) {
      task.abortCause = cause;
      task.abortController.abort(new Error(`Daemon shutdown (${cause})`));
    }
  }

  /** Startup stale-working recovery (ONLY touches `working` phases, never terminal/paused/needs_you). */
  startupSweep(now = Date.now()): number[] {
    return this.ledger.sweepStaleWorkingRuns(now);
  }

  /**
   * Executes one serialized reconciliation tick. Overlapping invocations return immediately.
   * When `opts.waitForAttempts` is true (e.g. `start --once` or tests), awaits spawned background tasks before returning.
   */
  async tick(now = Date.now(), opts: { waitForAttempts?: boolean } = {}): Promise<void> {
    if (this.isTicking) {
      return;
    }
    this.isTicking = true;
    try {
      await this.runTickInternal(now);
      if (opts.waitForAttempts) {
        await this.waitForActiveTasks();
      }
    } finally {
      this.isTicking = false;
    }
  }

  private async runTickInternal(now: number): Promise<void> {
    // 0. Flush durable outbox side effects (retries any labels/notifications lost on crash).
    await this.flushOutbox();

    const remoteUrl = await this.github.getRemoteUrlWithToken();
    await this.broker.ensureBareRepo(remoteUrl);
    const mainSha = await this.github.getBranchTipSha(this.cfg.defaultBranch);

    // Load optional `.agents/landing.json` strictly from `main` tip — isolated in try/catch so bad JSON never freezes kill-switches (Opus S13).
    try {
      const landingRaw = await this.broker.readFileAtRef(mainSha, ".agents/landing.json");
      const merged = mergeLandingJson(
        this.cfg.gate,
        this.cfg.requiredChecks,
        this.cfg.reviewRubric,
        landingRaw,
      );
      this.effectiveGate = merged.gate;
      this.effectiveRequiredChecks = merged.requiredChecks;
      this.effectiveReviewRubric = merged.reviewRubric;
    } catch (err) {
      this.effectiveGate = this.cfg.gate;
      this.effectiveRequiredChecks = this.cfg.requiredChecks;
      this.effectiveReviewRubric = this.cfg.reviewRubric;
      this.ledger.appendAudit("config/landing_json_invalid", null, "archangel", {
        mainSha,
        error: err instanceof Error ? err.message : String(err),
      }, now);
    }

    // 1. Process pending CLI -> Daemon handoff commands (Opus Step 6 / R5).
    await this.processPendingCommands(mainSha, now);

    // 2. Monitor post-merge main CI health & circuit breaker (isolated per merge — Opus S13).
    await this.reconcilePostMergeMain(mainSha, now);

    // 3. Intake eligible owner-authored, owner-labeled issues.
    const readyIssues = await this.github.listOpenIssuesByLabel(this.cfg.labels.readyForAgent);
    const issueMap = new Map<number, GitHubIssue>();
    for (const issue of readyIssues) {
      issueMap.set(issue.number, issue);
      await this.reconcileIntakeIssue(issue, now);
    }

    // 4. Reconcile all non-done Threads — in-progress BEFORE queued (prevents slot-lending stampedes).
    const openThreads = this.ledger
      .listThreads()
      .filter((t) => t.phase.kind !== "done");

    const inProgress = openThreads.filter((t) => t.phase.kind !== "queued");
    const queued = openThreads.filter((t) => t.phase.kind === "queued");

    for (const thread of inProgress) {
      const issue = await this.resolveIssueForThread(thread, issueMap);
      await this.reconcileThread(thread, issue, mainSha, now);
    }

    for (const thread of queued) {
      if (this.runningTasks.size >= this.cfg.maxConcurrentThreads) break;
      const issue = await this.resolveIssueForThread(thread, issueMap);
      if (!issue) continue;
      await this.reconcileThread(thread, issue, mainSha, now);
    }

    // Flush any newly enqueued outbox effects immediately.
    await this.flushOutbox();
  }

  private async resolveIssueForThread(
    thread: ThreadRecord,
    issueMap: Map<number, GitHubIssue>,
  ): Promise<GitHubIssue | undefined> {
    const cached = issueMap.get(thread.issueNumber);
    if (cached) return cached;
    try {
      const fetched = await this.github.getIssue(thread.issueNumber);
      issueMap.set(thread.issueNumber, fetched);
      return fetched;
    } catch {
      return undefined;
    }
  }

  private async flushOutbox(): Promise<void> {
    const items = this.ledger.listOutbox();
    for (const item of items) {
      try {
        const eff = item.effect;
        if (eff.kind === "add_label") {
          await this.github.addLabels(eff.issueNumber, [eff.label]);
        } else if (eff.kind === "remove_label") {
          await this.github.removeLabel(eff.issueNumber, eff.label);
        } else if (eff.kind === "notify_needs_you") {
          await this.notifier.notifyNeedsYou({
            issueNumber: eff.issueNumber,
            title: eff.title,
            reason: eff.reason,
          });
        }
        this.ledger.completeOutbox(item.id);
      } catch (err) {
        this.ledger.failOutbox(item.id, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async processPendingCommands(mainSha: string, now: number): Promise<void> {
    const cmds = this.ledger.listPendingCommands();
    for (const cmd of cmds) {
      if (cmd.kind !== "handoff") continue;
      try {
        const res = await this.prepareDaemonHandoff(cmd.issueNumber, mainSha, now);
        this.ledger.completeCommand(cmd.id, res, now);
      } catch (err) {
        this.ledger.failCommand(cmd.id, err instanceof Error ? err.message : String(err), now);
      }
    }
  }

  /**
   * Executes the daemon-owned half of Handoff (Opus Step 6 / R5):
   * aborts any active Attempt, pushes any valid unpushed commits via Broker, cleans clone,
   * adds `factory:paused`, and CAS-transitions to `owner_driving` (`mode: "advisory"`).
   */
  async prepareDaemonHandoff(
    issueNumber: number,
    mainSha: string,
    now = Date.now(),
  ): Promise<{ branchName: string; headSha: string | null }> {
    const running = this.runningTasks.get(issueNumber);
    if (running) {
      running.abortCause = "handoff";
      running.abortController.abort(new Error("Owner requested handoff"));
      await running.promise.catch(() => undefined);
    }

    const thread = this.ledger.getThread(issueNumber);
    if (!thread) {
      throw new Error(`Thread #${issueNumber} not found in Ledger`);
    }

    await this.github.addLabels(issueNumber, [this.cfg.labels.paused]);
    const pr = extractPrFromPhase(thread.phase);
    const res = this.applyMachineEvent(
      thread,
      { t: "handoff_started", paseoAgentId: null, paseoWorkspaceId: null, now },
      { auditTopic: "handoff/prepared", now },
    );
    if (!res) {
      throw new Error(`Could not transition Thread #${issueNumber} to owner_driving from ${thread.phase.kind}`);
    }
    return {
      branchName: thread.branchName,
      headSha: pr?.headSha ?? null,
    };
  }

  private async reconcileIntakeIssue(issue: GitHubIssue, now: number): Promise<void> {
    // ADR-0004 / B11: owner-authored issues ONLY (numeric user ID + OWNER association).
    if (issue.authorId !== this.cfg.ownerUserId || issue.authorAssociation !== "OWNER") {
      if (this.rejectedIssueCache.get(issue.number) !== issue.updatedAt) {
        this.rejectedIssueCache.set(issue.number, issue.updatedAt);
        this.ledger.appendAudit(
          "intake/rejected_untrusted_author",
          issue.number,
          issue.authorLogin,
          { authorId: issue.authorId, authorAssociation: issue.authorAssociation },
          now,
        );
      }
      return;
    }

    const existing = this.ledger.getThread(issue.number);
    if (existing) {
      return;
    }

    if (this.rejectedIssueCache.get(issue.number) === issue.updatedAt) {
      return;
    }

    const ownerLabeled = await this.github.verifyLabelActor(
      issue.number,
      this.cfg.labels.readyForAgent,
      this.cfg.ownerUserId,
    );
    if (!ownerLabeled) {
      this.rejectedIssueCache.set(issue.number, issue.updatedAt);
      this.ledger.appendAudit(
        "intake/rejected_label_actor",
        issue.number,
        "unknown",
        { label: this.cfg.labels.readyForAgent },
        now,
      );
      return;
    }

    const themeLabel = issue.labels.find((l) => l.startsWith("theme:")) ?? null;
    this.ledger.upsertThread({
      issueNumber: issue.number,
      title: issue.title,
      themeLabel,
      bodySha256: sha256(issue.body),
      phase: { kind: "queued" },
      mode: "autonomous",
      now,
    });
  }

  private applyMachineEvent(
    thread: ThreadRecord,
    ev: MachineEvent,
    extra: {
      bodySha256?: string;
      lastSummary?: string | null;
      incImplement?: boolean;
      incRevision?: boolean;
      incRebase?: boolean;
      auditTopic?: string;
      auditPayload?: unknown;
      now?: number;
    } = {},
  ): ThreadRecord | null {
    const stepped = stepPhase(thread.phase, thread.mode, ev, {
      issueNumber: thread.issueNumber,
      title: thread.title,
      needsYouLabel: this.cfg.labels.needsYou,
    });
    if (!stepped.ok) {
      return null;
    }
    return this.ledger.transition(thread.issueNumber, thread.version, stepped.next, {
      nextMode: stepped.nextMode,
      effects: stepped.effects,
      ...extra,
    });
  }

  private async reconcileThread(
    thread: ThreadRecord,
    issue: GitHubIssue | undefined,
    mainSha: string,
    now: number,
  ): Promise<void> {
    if (thread.phase.kind === "done") return;

    // Load live PR whenever the phase carries a PR reference.
    const prRef = extractPrFromPhase(thread.phase);
    let pr: GitHubPr | null = null;
    if (prRef) {
      pr = await this.github.getPrLive(prRef.prNumber);
    } else if (thread.phase.kind === "working" && thread.phase.prNumber) {
      pr = await this.github.getPrLive(thread.phase.prNumber);
    }

    // 1. Universal PR closed/merged observation (fixes Opus S7, S8, S9 & Neon P0.3!).
    if (pr && pr.state === "closed") {
      const running = this.runningTasks.get(thread.issueNumber);
      if (running) {
        running.abortCause = "control";
        running.abortController.abort(new Error("PR closed externally"));
      }
      this.applyMachineEvent(
        thread,
        { t: "pr_observed", status: pr.merged ? "merged" : "closed" },
        {
          auditTopic: pr.merged ? "thread/owner_merged" : "thread/pr_closed",
          auditPayload: { prNumber: pr.number, mergeCommitSha: pr.mergeCommitSha },
          now,
        },
      );
      return;
    }

    // 2. Sync Shadow Mode disagreement label idempotently (fixes Opus O4).
    const combinedLabels = [...new Set([...(issue?.labels ?? []), ...(pr?.labels ?? [])])];
    if (thread.phase.kind === "shadow_ready") {
      this.ledger.markShadowDisagree(
        thread.issueNumber,
        combinedLabels.includes(this.cfg.labels.disagree),
      );
    }

    // 3. Derive live owner Control from combined labels (NEVER stored as a Phase — fixes O1, O2, S2, S3!).
    const control = deriveControl(combinedLabels, this.cfg.labels);
    if (control !== "run") {
      const running = this.runningTasks.get(thread.issueNumber);
      if (running) {
        running.abortCause = "control";
        running.abortController.abort(new Error(`Owner control is ${control}`));
      }
      return;
    }

    // 4. Owner-driving (Paseo Handoff) stays parked until explicit `archangel resume`.
    if (thread.phase.kind === "owner_driving") {
      return;
    }

    // 5. `needs_you`: if owner cleared the `needs-you` label on GitHub, resume cleanly & re-snapshot bodySha (fixes S4, S15!).
    if (thread.phase.kind === "needs_you") {
      if (issue && !combinedLabels.includes(this.cfg.labels.needsYou)) {
        const retried = this.applyMachineEvent(
          thread,
          { t: "owner_retry" },
          { bodySha256: sha256(issue.body), auditTopic: "thread/owner_retried", now },
        );
        if (retried) {
          thread = retried;
        } else {
          return;
        }
      } else {
        return;
      }
    }

    // 6. Body edit TOCTOU check (ONLY while control === 'run' and not already needs_you/owner_driving/done — fixes O2, O3!).
    if (issue && sha256(issue.body) !== thread.bodySha256) {
      const running = this.runningTasks.get(thread.issueNumber);
      if (running) {
        running.abortCause = "control";
        running.abortController.abort(new Error("Issue body modified mid-attempt"));
      }
      const escalated = this.applyMachineEvent(
        thread,
        {
          t: "escalate",
          code: "body_changed",
          reason: "Issue body changed after intake snapshot (body hash mismatch); remove needs-you label or run `archangel retry` after reviewing.",
        },
        { auditTopic: "thread/needs_you", now },
      );
      if (escalated && pr) {
        await this.postRecapSafe(escalated, pr, [{ code: "paused", message: "Issue body changed after intake" }]);
      }
      return;
    }

    // 7. If PR head moved externally (e.g., owner pushed to factory/<n>), restart Gate wait on the live headSha (Opus Step 5).
    if (
      pr &&
      (thread.phase.kind === "awaiting_gate" ||
        thread.phase.kind === "reviewing" ||
        thread.phase.kind === "landing" ||
        thread.phase.kind === "shadow_ready") &&
      pr.headSha !== thread.phase.headSha
    ) {
      const moved = this.applyMachineEvent(
        thread,
        { t: "head_moved", pr: { prNumber: pr.number, headSha: pr.headSha, baseSha: pr.baseSha }, now },
        { auditTopic: "thread/head_moved", auditPayload: { oldSha: thread.phase.headSha, newSha: pr.headSha }, now },
      );
      if (!moved) return;
      thread = moved;
    }

    // 8. Dispatch by explicit Phase!
    switch (thread.phase.kind) {
      case "working":
        // Single-flight background runner is already handling it.
        return;

      case "queued": {
        if (!issue || this.runningTasks.size >= this.cfg.maxConcurrentThreads) return;
        await this.spawnAttempt(thread, issue, "implement", mainSha, [], [], now);
        return;
      }

      case "awaiting_gate": {
        if (!pr) return;
        await this.reconcileGateWait(thread, pr, issue, mainSha, now);
        return;
      }

      case "reviewing": {
        if (!pr || !issue) return;
        await this.reconcileReviews(thread, pr, issue, mainSha, now);
        return;
      }

      case "landing": {
        if (!pr) return;
        await this.reconcileLanding(thread, pr, issue, mainSha, now);
        return;
      }

      case "shadow_ready": {
        // Already recorded shadow verdict; nothing to overwrite while PR remains open at same headSha.
        return;
      }
    }
  }

  private async spawnAttempt(
    thread: ThreadRecord,
    issue: GitHubIssue,
    kind: AttemptKind,
    mainSha: string,
    gateViolations: string[],
    structuredFindings: Array<{ vendor: string; findings: ReviewFinding[] }>,
    now: number,
    explicitStartSha?: string,
  ): Promise<boolean> {
    if (this.runningTasks.has(thread.issueNumber)) {
      return false;
    }
    if (thread.mode === "advisory") {
      // Structurally forbidden in advisory mode (ADR-0006 / Opus R4).
      return false;
    }
    if (thread.implementCount >= this.cfg.maxImplementAttemptsPerThread) {
      this.applyMachineEvent(
        thread,
        {
          t: "escalate",
          code: "max_attempts",
          reason: `Reached max implement attempts (${thread.implementCount}/${this.cfg.maxImplementAttemptsPerThread}).`,
        },
        { auditTopic: "thread/needs_you", now },
      );
      return false;
    }

    // Atomic budget reservation BEFORE launching paid work (Codex #10 & Opus R8 — no $0.50 overshoot floor!).
    const desiredReserve = Math.min(this.cfg.maxDailyUsd, 5.0);
    const reservedUsd = this.ledger.reserveBudget(this.cfg.maxDailyUsd, desiredReserve, 0.05, now);
    if (reservedUsd === null) {
      this.ledger.appendAudit(
        "budget/daily_cap_reached",
        thread.issueNumber,
        "archangel",
        { ...this.ledger.getSpendBreakdown(now), maxDailyUsd: this.cfg.maxDailyUsd },
        now,
      );
      return false;
    }

    const attempt = this.ledger.startAttempt(thread.issueNumber, kind, now);
    const fromSha =
      explicitStartSha ??
      (kind === "implement" ? mainSha : (extractPrFromPhase(thread.phase)?.headSha ?? mainSha));

    const workingThread = this.applyMachineEvent(
      thread,
      {
        t: "start_working",
        attemptId: attempt.id,
        attempt: kind,
        fromSha,
        prNumber: extractPrFromPhase(thread.phase)?.prNumber ?? null,
      },
      {
        incImplement: true,
        incRevision: kind === "revise",
        incRebase: kind === "rebase",
        auditTopic: "thread/working",
        now,
      },
    );

    if (!workingThread) {
      this.ledger.finishAttempt(attempt.id, {
        status: "aborted",
        reservedUsd,
        costUsd: 0,
        errorMessage: "CAS transition to working rejected",
      });
      return false;
    }

    const abortController = new AbortController();
    const task: RunningTask = {
      issueNumber: thread.issueNumber,
      attemptId: attempt.id,
      abortController,
      abortCause: null,
      cloneDir: "",
      promise: Promise.resolve(),
    };

    const runPromise = this.executeAttemptTask(
      workingThread,
      issue,
      attempt.id,
      kind,
      fromSha,
      mainSha,
      reservedUsd,
      gateViolations,
      structuredFindings,
      task,
    );
    task.promise = runPromise;
    this.runningTasks.set(thread.issueNumber, task);
    return true;
  }

  private async executeAttemptTask(
    workingThread: ThreadRecord,
    issue: GitHubIssue,
    attemptId: number,
    kind: AttemptKind,
    fromSha: string,
    mainSha: string,
    reservedUsd: number,
    gateViolations: string[],
    structuredFindings: Array<{ vendor: string; findings: ReviewFinding[] }>,
    task: RunningTask,
  ): Promise<void> {
    let cloneDir = "";
    let actualCostUsd = 0;
    let transcriptPath: string | null = null;

    try {
      cloneDir = await this.broker.createThrowawayClone(workingThread.issueNumber, fromSha);
      task.cloneDir = cloneDir;

      // Run repo `.agents/setup` strictly from mainSha with scrubbed env.
      await this.broker.runRepoSetup(cloneDir, mainSha, this.cfg.setupTimeoutMs);

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

      const result: ImplementResult = await this.implementer.run({
        issueNumber: issue.number,
        cloneDir,
        prompt,
        abortController: task.abortController,
        maxTurns: this.cfg.implementMaxTurns,
        timeoutMs: this.cfg.implementTimeoutMs,
        maxBudgetUsd: reservedUsd,
      });

      actualCostUsd = result.costUsd;
      transcriptPath = result.transcriptPath;

      if (result.aborted) {
        const cause = task.abortCause ?? "timeout";
        this.ledger.finishAttempt(attemptId, {
          status: "aborted",
          costUsd: actualCostUsd,
          reservedUsd,
          transcriptPath,
          errorMessage: `Aborted (${cause})`,
        });

        // If handoff aborted us, try to push any valid unpushed factory commits before releasing!
        if (cause === "handoff") {
          try {
            const val = await this.broker.fetchAndValidateFromClone(
              cloneDir,
              workingThread.issueNumber,
              mainSha,
              this.effectiveGate,
            );
            if (val.protectedViolations.length === 0) {
              const freshRemoteUrl = await this.github.getRemoteUrlWithToken();
              await this.broker.pushFactoryBranch(workingThread.branchName, val.headSha, freshRemoteUrl);
              this.ledger.recordPushedSha(val.headSha, workingThread.issueNumber, "broker");
            }
          } catch {
            // Non-fatal during handoff abort if clone had no commits.
          }
        }

        const latest = this.ledger.getThread(workingThread.issueNumber);
        if (latest && latest.version === workingThread.version) {
          this.applyMachineEvent(
            latest,
            { t: "attempt_aborted", cause, now: Date.now() },
            { auditTopic: "attempt/aborted", auditPayload: { cause }, now: Date.now() },
          );
        }
        return;
      }

      // Hardened fetch + pre-push validation (including local `archangel-gate` if built — Neon P1).
      const validation = await this.broker.fetchAndValidateFromClone(
        cloneDir,
        workingThread.issueNumber,
        mainSha,
        this.effectiveGate,
      );

      if (validation.protectedViolations.length > 0) {
        this.ledger.finishAttempt(attemptId, {
          status: "failed",
          headSha: validation.headSha,
          costUsd: actualCostUsd,
          reservedUsd,
          transcriptPath,
          errorMessage: validation.protectedViolations.join("; "),
        });
        const latest = this.ledger.getThread(workingThread.issueNumber);
        if (latest && latest.version === workingThread.version) {
          this.applyMachineEvent(
            latest,
            {
              t: "attempt_failed",
              code: "broker_policy_failed",
              reason: `Broker pre-push validation failed: ${validation.protectedViolations.join("; ")}`,
            },
            { auditTopic: "thread/needs_you" },
          );
        }
        return;
      }

      // Local `archangel-gate` pre-push verification (Neon P1).
      if (validation.gateReport && !validation.gateReport.passed) {
        const rep = validation.gateReport;
        this.ledger.finishAttempt(attemptId, {
          status: "failed",
          headSha: validation.headSha,
          costUsd: actualCostUsd,
          reservedUsd,
          transcriptPath,
          errorMessage: rep.violations.join("; "),
        });

        const latest = this.ledger.getThread(workingThread.issueNumber);
        if (!latest || latest.version !== workingThread.version) return;

        if (rep.already_fixed) {
          this.applyMachineEvent(
            latest,
            {
              t: "attempt_failed",
              code: "already_fixed",
              reason: "Mechanical Gate: already-fixed (repro test already passes on main)",
            },
            { auditTopic: "thread/needs_you" },
          );
          return;
        }

        // Allow 1 pre-push local revision starting from the unpushed staging SHA!
        if (kind === "implement" && latest.revisionCount < this.cfg.maxRevisionsPerThread) {
          const backToQueued = this.applyMachineEvent(
            latest,
            { t: "attempt_aborted", cause: "control", now: Date.now() },
            { auditTopic: "gate/local_failed_revising", auditPayload: { violations: rep.violations } },
          );
          if (backToQueued) {
            // Release current runningTasks entry before spawning the pre-push revision.
            this.runningTasks.delete(workingThread.issueNumber);
            this.broker.removeClone(cloneDir);
            cloneDir = "";
            await this.spawnAttempt(
              backToQueued,
              issue,
              "revise",
              mainSha,
              rep.violations,
              [],
              Date.now(),
              validation.headSha,
            );
          }
          return;
        }

        this.applyMachineEvent(
          latest,
          {
            t: "attempt_failed",
            code: "gate_failed",
            reason: `Local mechanical Gate failed: ${rep.violations.join("; ")}`,
          },
          { auditTopic: "thread/needs_you" },
        );
        return;
      }

      // Re-check live GitHub kill-switch & CAS version right before pushing (Opus R6!).
      const liveIssue = await this.github.getIssue(issue.number);
      if (deriveControl(liveIssue.labels, this.cfg.labels) !== "run") {
        this.ledger.finishAttempt(attemptId, {
          status: "aborted",
          headSha: validation.headSha,
          costUsd: actualCostUsd,
          reservedUsd,
          transcriptPath,
          errorMessage: "Aborted right before push due to owner stop/pause label",
        });
        const latest = this.ledger.getThread(workingThread.issueNumber);
        if (latest && latest.version === workingThread.version) {
          this.applyMachineEvent(latest, { t: "attempt_aborted", cause: "control", now: Date.now() });
        }
        return;
      }

      // Freshly mint push token immediately before pushing (fixes Opus R7 token expiry mid-attempt!).
      const freshRemoteUrl = await this.github.getRemoteUrlWithToken();
      await this.broker.pushFactoryBranch(workingThread.branchName, validation.headSha, freshRemoteUrl);
      this.ledger.recordPushedSha(validation.headSha, workingThread.issueNumber, "broker");

      const pr = await this.github.createPr({
        title: `fix(#${issue.number}): ${issue.title}`,
        body: `Closes #${issue.number}\n\nAutomated fix by Archangel.`,
        head: workingThread.branchName,
        base: this.cfg.defaultBranch,
      });

      this.ledger.finishAttempt(attemptId, {
        status: "succeeded",
        headSha: validation.headSha,
        costUsd: actualCostUsd,
        reservedUsd,
        transcriptPath,
      });

      const latest = this.ledger.getThread(workingThread.issueNumber);
      if (latest && latest.version === workingThread.version) {
        const updated = this.applyMachineEvent(
          latest,
          {
            t: "attempt_pushed",
            pr: { prNumber: pr.number, headSha: validation.headSha, baseSha: pr.baseSha },
            now: Date.now(),
          },
          { lastSummary: result.summary, auditTopic: "thread/pr_pushed" },
        );
        if (updated) {
          await this.postRecapSafe(updated, pr, [
            { code: "check_pending", message: "Waiting for required Gate & CI checks" },
          ]);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ledger.finishAttempt(attemptId, {
        status: "failed",
        costUsd: actualCostUsd,
        reservedUsd,
        transcriptPath,
        errorMessage: msg,
      });
      const latest = this.ledger.getThread(workingThread.issueNumber);
      if (latest && latest.version === workingThread.version) {
        this.applyMachineEvent(
          latest,
          { t: "attempt_failed", code: "attempt_failed", reason: `Implement attempt failed: ${msg}` },
          { auditTopic: "thread/needs_you" },
        );
      }
    } finally {
      if (this.runningTasks.get(workingThread.issueNumber) === task) {
        this.runningTasks.delete(workingThread.issueNumber);
      }
      if (cloneDir) {
        this.broker.removeClone(cloneDir);
      }
    }
  }

  private async reconcileGateWait(
    thread: ThreadRecord,
    pr: GitHubPr,
    issue: GitHubIssue | undefined,
    mainSha: string,
    now: number,
  ): Promise<void> {
    if (thread.phase.kind !== "awaiting_gate") return;

    const checks = await this.github.getCheckRunsForRef(pr.headSha);
    const verdict = classifyGate({
      requiredChecks: this.effectiveRequiredChecks,
      checks,
      since: thread.phase.since,
      nudgedAt: thread.phase.nudgedAt,
      now,
      graceMs: this.cfg.gateStartGraceMs,
      timeoutMs: this.cfg.gateTimeoutMs,
    });

    switch (verdict.status) {
      case "missing_grace":
      case "pending":
        return;

      case "missing_nudge":
        this.applyMachineEvent(
          thread,
          { t: "gate_nudged", now },
          { auditTopic: "gate/grace_exceeded", auditPayload: { missing: verdict.missing }, now },
        );
        return;

      case "timeout":
        this.applyMachineEvent(
          thread,
          { t: "escalate", code: "gate_timeout", reason: verdict.detail },
          { auditTopic: "thread/needs_you", now },
        );
        return;

      case "untrusted":
        this.applyMachineEvent(
          thread,
          {
            t: "escalate",
            code: "gate_untrusted",
            reason: `Untrusted check source: ${verdict.names.join(", ")}`,
          },
          { auditTopic: "thread/needs_you", now },
        );
        return;

      case "failed": {
        const failMsgs = verdict.failed.map((f) => `${f.name}: ${f.conclusion}`);
        if (
          thread.mode === "autonomous" &&
          issue &&
          thread.revisionCount < this.cfg.maxRevisionsPerThread &&
          this.runningTasks.size < this.cfg.maxConcurrentThreads
        ) {
          await this.spawnAttempt(thread, issue, "revise", mainSha, failMsgs, [], now);
        } else {
          this.applyMachineEvent(
            thread,
            {
              t: "escalate",
              code: "gate_failed",
              reason: `Required checks failed (${thread.mode} mode): ${failMsgs.join(", ")}`,
            },
            { auditTopic: "thread/needs_you", now },
          );
        }
        return;
      }

      case "green": {
        const updated = this.applyMachineEvent(
          thread,
          { t: "gate_passed" },
          { auditTopic: "gate/passed", now },
        );
        if (updated && issue) {
          await this.reconcileReviews(updated, pr, issue, mainSha, now);
        }
      }
    }
  }

  private async reconcileReviews(
    thread: ThreadRecord,
    pr: GitHubPr,
    issue: GitHubIssue,
    mainSha: string,
    now: number,
  ): Promise<void> {
    if (thread.phase.kind !== "reviewing") return;
    const headSha = thread.phase.headSha;
    const existing = this.ledger.getReviewsForSha(thread.issueNumber, headSha);
    const haveOpenAi = existing.some((r) => r.vendor === "openai");
    const haveGemini = existing.some((r) => r.vendor === "gemini");

    if (!haveOpenAi || !haveGemini) {
      // Reserve daily budget BEFORE paid reviewer calls (Codex #10).
      const reservedUsd = this.ledger.reserveBudget(
        this.cfg.maxDailyUsd,
        REVIEW_RESERVATION_USD,
        0.01,
        now,
      );
      if (reservedUsd === null) {
        this.ledger.appendAudit(
          "budget/daily_cap_reached",
          thread.issueNumber,
          "archangel",
          { phase: "reviewing", ...this.ledger.getSpendBreakdown(now) },
          now,
        );
        return;
      }

      let reviewCostTotal = 0;
      try {
        // Fail CLOSED on diff retrieval failure — NEVER feed an empty diff to reviewers (Codex #4 & Opus L6!).
        const { diffText, touchedFiles } = await this.broker.getDiffAndTouchedFiles(
          pr.baseSha,
          headSha,
        );
        if (!diffText.trim()) {
          throw new Error(`Empty diff between base ${pr.baseSha.slice(0, 8)} and head ${headSha.slice(0, 8)}`);
        }

        const batch = await this.reviewers.reviewAll({
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body,
          headSha,
          diffText,
          touchedFiles,
          reviewRubric: this.effectiveReviewRubric,
          skipVendors: [
            ...(haveOpenAi ? (["openai"] as const) : []),
            ...(haveGemini ? (["gemini"] as const) : []),
          ],
        });

        // Persist EVERY settled vendor result immediately even if the other vendor failed (Opus L4/M5!).
        for (const r of batch.results) {
          reviewCostTotal += r.costUsd;
          this.ledger.recordReview({
            issueNumber: thread.issueNumber,
            headSha,
            vendor: r.vendor,
            verdict: r.verdict,
            findings: r.findings,
            costUsd: 0, // Settled via reserveBudget/settleBudget below to avoid double-counting.
            now,
          });
        }
        this.ledger.settleBudget(reservedUsd, reviewCostTotal, now);

        if (batch.errors.length > 0) {
          const errMsg = batch.errors.map((e) => `${e.vendor}: ${e.error}`).join("; ");
          await this.handleReviewOutage(thread, errMsg, now);
          return;
        }
      } catch (err) {
        this.ledger.settleBudget(reservedUsd, reviewCostTotal, now);
        const msg = err instanceof Error ? err.message : String(err);
        await this.handleReviewOutage(thread, msg, now);
        return;
      }
    }

    const reviews = this.ledger.getReviewsForSha(thread.issueNumber, headSha);
    if (reviews.length < 2) return;

    const vetoes = reviews.filter((r) => r.verdict !== "approve");
    if (vetoes.length > 0) {
      const structuredFindings = vetoes.map((v) => ({
        vendor: v.vendor,
        findings: JSON.parse(v.findingsJson) as ReviewFinding[],
      }));

      if (
        thread.mode === "autonomous" &&
        thread.revisionCount < this.cfg.maxRevisionsPerThread &&
        this.runningTasks.size < this.cfg.maxConcurrentThreads
      ) {
        await this.spawnAttempt(thread, issue, "revise", mainSha, [], structuredFindings, now);
      } else {
        const escalated = this.applyMachineEvent(
          thread,
          {
            t: "escalate",
            code: "review_vetoed",
            reason: `Independent reviewer vetoed ${headSha.slice(0, 8)} (${vetoes.map((v) => v.vendor).join(", ")}).`,
          },
          { auditTopic: "thread/needs_you", now },
        );
        if (escalated) {
          await this.postRecapSafe(escalated, pr, [
            { code: "review_vetoed", message: `Vetoed by ${vetoes.map((v) => v.vendor).join(", ")}` },
          ]);
        }
      }
      return;
    }

    const landing = this.applyMachineEvent(
      thread,
      { t: "reviews_approved" },
      { auditTopic: "review/quorum_approved", now },
    );
    if (landing) {
      await this.reconcileLanding(landing, pr, issue, mainSha, now);
    }
  }

  private async handleReviewOutage(thread: ThreadRecord, errMsg: string, now: number): Promise<void> {
    if (thread.phase.kind !== "reviewing") return;
    const outageSince = thread.phase.outageSince ?? now;
    if (now - outageSince >= this.cfg.reviewerOutageMaxMs) {
      this.applyMachineEvent(
        thread,
        {
          t: "escalate",
          code: "review_outage",
          reason: `Reviewer unavailable for >= ${Math.round(this.cfg.reviewerOutageMaxMs / 3_600_000)}h: ${errMsg}`,
        },
        { auditTopic: "thread/needs_you", now },
      );
      return;
    }
    if (thread.phase.outageSince === null) {
      this.applyMachineEvent(
        thread,
        { t: "review_outage", now },
        { auditTopic: "review/outage_started", auditPayload: { error: errMsg }, now },
      );
    }
  }

  private async reconcileLanding(
    thread: ThreadRecord,
    _stalePr: GitHubPr,
    issue: GitHubIssue | undefined,
    mainSha: string,
    now: number,
  ): Promise<void> {
    if (thread.phase.kind !== "landing") return;

    // Live re-read right before landing (ADR-0004 / B7 TOCTOU defense).
    const pr = await this.github.getPrLive(thread.phase.prNumber);
    if (pr.state === "closed") {
      this.applyMachineEvent(
        thread,
        { t: "pr_observed", status: pr.merged ? "merged" : "closed" },
        { auditTopic: pr.merged ? "thread/owner_merged" : "thread/pr_closed", now },
      );
      return;
    }

    const checks = await this.github.getCheckRunsForRef(pr.headSha);
    const mainChecks = await this.github.getCheckRunsForRef(mainSha);

    // Fail CLOSED on missing/untrusted main checks (Codex #2 & Neon P0.5 — no hardcoded "Test ("!).
    const mainRequired = this.effectiveRequiredChecks.filter((n) => n !== "Gate");
    const mainTipGreen =
      mainRequired.length > 0 &&
      mainRequired.every((reqName) => {
        const run = mainChecks.find((c) => c.name === reqName);
        return (
          run !== undefined &&
          run.appSlug === "github-actions" &&
          run.status === "completed" &&
          run.conclusion === "success"
        );
      });

    const shaInfo = this.ledger.isKnownSha(thread.issueNumber, pr.headSha);
    const protectedFilesTouched = pr.changedFiles.filter((f) =>
      isProtectedPath(f, this.effectiveGate.extraProtectedPaths),
    );
    const mergeTreeClean = await this.broker.isMergeTreeClean(mainSha, pr.headSha);
    const reviews = this.ledger.getReviewsForSha(thread.issueNumber, pr.headSha);
    const cb = this.ledger.getCircuitBreaker();

    // Strict branch freshness: PR base SHA MUST match current main tip (Codex #3 — never substitute mergeTreeClean!).
    const branchUpToDateWithMain = pr.baseSha === mainSha;

    const blockers = computeBlockers({
      prOpen: pr.state === "open",
      prDraft: pr.draft,
      headSha: pr.headSha,
      shaRecordedByBroker: shaInfo.known && shaInfo.origin === "broker",
      postHandoff: thread.mode === "advisory",
      labels: [...new Set([...pr.labels, ...(issue?.labels ?? [])])],
      pauseLabel: this.cfg.labels.paused,
      stopLabel: this.cfg.labels.stop,
      circuitBreakerTripped: cb.tripped,
      mainTipGreen,
      branchUpToDateWithMain,
      protectedFilesTouched,
      requiredChecks: this.effectiveRequiredChecks,
      checks,
      reviewsForHeadSha: reviews,
      requiredReviewers: ["openai", "gemini"],
      mergeTreeClean,
      autoMergesToday: this.ledger.getAutoMergeCountToday(now),
      maxAutoMergesPerDay: this.cfg.maxAutoMergesPerDay,
      shadowMode: this.cfg.shadowMode,
    });

    // Handle merge conflicts or stale base with 1 automated rebase Attempt (autonomous mode only!).
    if (
      blockers.some((b) => b.code === "merge_conflict" || b.code === "branch_behind_main") &&
      thread.mode === "autonomous"
    ) {
      if (
        issue &&
        thread.rebaseCount < this.cfg.maxRebasesPerThread &&
        this.runningTasks.size < this.cfg.maxConcurrentThreads
      ) {
        await this.spawnAttempt(thread, issue, "rebase", mainSha, [], [], now);
        return;
      }
      const escalated = this.applyMachineEvent(
        thread,
        {
          t: "escalate",
          code: "merge_conflict",
          reason: "Branch is behind main or conflicted after max rebase attempts.",
        },
        { auditTopic: "thread/needs_you", now },
      );
      if (escalated) {
        await this.postRecapSafe(escalated, pr, blockers);
      }
      return;
    }

    // Shadow Mode: ready except for shadow_mode_active.
    if (isShadowReady(blockers)) {
      const verdict = this.ledger.recordMerge({
        issueNumber: thread.issueNumber,
        prNumber: pr.number,
        headSha: pr.headSha,
        shadowOnly: true,
        now,
      });
      const updated = this.applyMachineEvent(
        thread,
        { t: "shadow_recorded", verdictId: verdict.id },
        { auditTopic: "thread/shadow_ready", now },
      );
      if (updated) {
        await this.postRecapSafe(updated, pr, blockers, { wouldMerge: true });
      }
      return;
    }

    if (blockers.length > 0) {
      await this.postRecapSafe(thread, pr, blockers);
      return;
    }

    // All blockers empty -> squash merge pinned strictly to approved head SHA (B7 + Opus S10 recovery!).
    let squashSha: string;
    try {
      const mergedRes = await this.github.squashMergePr(
        pr.number,
        pr.headSha,
        `fix(#${thread.issueNumber}): ${thread.title} (#${pr.number})`,
      );
      squashSha = mergedRes.squashSha;
    } catch (err) {
      // Re-read PR to recover if merge actually succeeded before a network error/timeout (Opus S10).
      const after = await this.github.getPrLive(pr.number).catch(() => null);
      if (!after?.merged || !after.mergeCommitSha) {
        throw err;
      }
      squashSha = after.mergeCommitSha;
    }

    const mergeRow = this.ledger.recordMerge({
      issueNumber: thread.issueNumber,
      prNumber: pr.number,
      headSha: pr.headSha,
      squashSha,
      shadowOnly: false,
      now,
    });
    const mergedThread = this.applyMachineEvent(
      thread,
      { t: "landed", mergeId: mergeRow.id },
      {
        lastSummary: `Squash-merged into \`${this.cfg.defaultBranch}\` at \`${squashSha.slice(0, 10)}\`.`,
        auditTopic: "thread/merged",
        now,
      },
    );
    if (mergedThread) {
      await this.postRecapSafe(mergedThread, pr, []);
    }
  }

  /**
   * Post-merge main health watch (Opus Step 5 / R10 / S11 / S13):
   * Uses `MainWatch`, configured non-Gate `requiredChecks`, tracks exact rerun IDs,
   * enforces watch timeout, and isolates each merge in its own try/catch.
   */
  private async reconcilePostMergeMain(mainSha: string, now: number): Promise<void> {
    const pending = this.ledger.listPendingPostMergeChecks();
    if (pending.length === 0) return;

    const mainRequired = this.effectiveRequiredChecks.filter((n) => n !== "Gate");
    if (mainRequired.length === 0) return;

    for (const m of pending) {
      try {
        await this.reconcileOnePostMerge(m, mainRequired, mainSha, now);
      } catch (err) {
        this.ledger.appendAudit(
          "post_merge/error",
          m.issueNumber,
          "archangel",
          { mergeId: m.id, error: err instanceof Error ? err.message : String(err) },
          now,
        );
      }
    }
  }

  private async reconcileOnePostMerge(
    m: MergeRecord,
    mainRequired: string[],
    mainSha: string,
    now: number,
  ): Promise<void> {
    if (!m.squashSha) return;
    const checks = await this.github.getCheckRunsForRef(m.squashSha);
    const matched = mainRequired
      .map((name) => checks.find((c) => c.name === name && c.appSlug === "github-actions"))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);

    const watch: MainWatch = m.mainWatch;
    const startedAt = watch.kind === "watching" ? watch.since : watch.kind === "rerun_requested" ? watch.at : m.createdAt;

    if (matched.length < mainRequired.length || matched.some((c) => c.status !== "completed")) {
      if (now - startedAt > POST_MERGE_WATCH_TIMEOUT_MS) {
        this.ledger.updateMergeMainWatch(m.id, { kind: "timed_out", at: now });
        this.ledger.appendAudit("post_merge/timed_out", m.issueNumber, "archangel", { mergeId: m.id }, now);
      }
      return;
    }

    const failed = matched.filter((c) => c.conclusion !== "success");
    if (failed.length === 0) {
      this.ledger.updateMergeMainWatch(m.id, { kind: "green" });
      return;
    }

    if (watch.kind === "watching") {
      const runIds: number[] = [];
      let rerunPermitted = true;
      for (const f of failed) {
        try {
          await this.github.rerunCheckRun(f.id);
          runIds.push(f.id);
        } catch (err) {
          // Under strict ADR-0004 least-privilege (checks:read, no checks:write), rerequest returns 403.
          // Fail closed immediately into circuit-breaker + exact revert PR instead of wedging in `watching`.
          rerunPermitted = false;
          this.ledger.appendAudit(
            "post_merge/rerun_unavailable",
            m.issueNumber,
            "archangel",
            { mergeId: m.id, checkRunId: f.id, error: err instanceof Error ? err.message : String(err) },
            now,
          );
          break;
        }
      }
      if (rerunPermitted && runIds.length > 0) {
        this.ledger.updateMergeMainWatch(m.id, { kind: "rerun_requested", runIds, at: now });
        return;
      }
      // Fall through to confirm red main immediately when rerun is not permitted.
    }

    if (watch.kind === "rerun_requested" || watch.kind === "watching") {
      // Wait if GitHub hasn't yet reflected the rerun (or if the rerun is still in progress).
      // Since our GitHub client deduplicates to latest id, if all failed ids are still completed+failed,
      // confirm red main!
      const reason = `main CI failed on factory squash ${m.squashSha.slice(0, 10)} (issue #${m.issueNumber})`;
      this.ledger.setCircuitBreaker(true, reason, now);

      if (mainSha === m.squashSha) {
        const rev = await this.broker.createExactRevertBranch(m.issueNumber, mainSha, m.squashSha);
        const freshRemoteUrl = await this.github.getRemoteUrlWithToken();
        await this.broker.pushFactoryBranch(rev.branchName, rev.headSha, freshRemoteUrl);
        const revertPr = await this.github.createPr({
          title: `revert(#${m.issueNumber}): revert ${m.squashSha.slice(0, 8)} after red main`,
          body: `Automated exact-inverse revert of ${m.squashSha} (PR #${m.prNumber}) after confirmed CI failure on \`${this.cfg.defaultBranch}\`.\n\nGlobal landing circuit breaker is now **TRIPPED**.`,
          head: rev.branchName,
          base: this.cfg.defaultBranch,
        });
        this.ledger.updateMergeMainWatch(m.id, {
          kind: "red",
          revertPrNumber: revertPr.number,
          escalated: false,
        });
        await this.notifier.notifyNeedsYou({
          issueNumber: m.issueNumber,
          title: `Red main after merge of PR #${m.prNumber}`,
          reason: `Circuit breaker tripped and exact-inverse revert PR #${revertPr.number} opened.`,
        });
      } else {
        this.ledger.updateMergeMainWatch(m.id, {
          kind: "red",
          revertPrNumber: null,
          escalated: true,
        });
        await this.notifier.notifyNeedsYou({
          issueNumber: m.issueNumber,
          title: `Red main on ${m.squashSha.slice(0, 8)} (multiple merges interleaved)`,
          reason: "Circuit breaker tripped; manual revert needed because main has moved.",
        });
      }
    }
  }

  private async postRecapSafe(
    thread: ThreadRecord,
    pr: GitHubPr,
    blockers: ReturnType<typeof computeBlockers>,
    opts: { wouldMerge?: boolean } = {},
  ): Promise<void> {
    const reviews = this.ledger.getReviewsForSha(thread.issueNumber, pr.headSha);
    await this.github.upsertRecapComment(
      pr.number,
      renderRecapComment({
        thread,
        reviews,
        blockers,
        wouldMerge: opts.wouldMerge,
      }),
    );
  }
}
