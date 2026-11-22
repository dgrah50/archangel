import crypto from "node:crypto";
import { COMMAND_LINE_RE, collectOwnerReply } from "./owner-reply.js";
import { MAIN_ESCALATION_POLICY, describeEscalation, formatDecisionClass } from "./escalations.js";
import { GatePolicySchema, resolveRequiredReviewers, type ArchangelConfig, type GatePolicy } from "../config.js";
import type { Implementer, ImplementResult } from "../agents/implementer.js";
import {
  buildImplementPrompt,
  buildRebasePrompt,
  buildRevisionPrompt,
  promptTemplateSha,
  rubricSha,
} from "../agents/prompts.js";
import type { ReviewerSuite } from "../agents/reviewers.js";
import { isProtectedPath, type GitBroker } from "../broker/git-broker.js";
import type { GateProof } from "../gate/gate.js";
import type { GitHubClient, GitHubIssue, GitHubPr, IssueComment } from "../github/client.js";
import type { MergeRecord, ReviewFinding, ReviewerVendor, ThreadRecord } from "../ledger/schema.js";
import type { Ledger } from "../ledger/store.js";
import { branchNameFor, workClassOfBranch, type WorkClass } from "./work-class.js";
import { computeBlockers, isShadowReady } from "./blockers.js";
import { NOOP_LOGGER, type Logger } from "./logger.js";
import type { Notifier } from "./notifier.js";
import { renderRecapComment } from "./recap.js";
import { runScoutsForProject, scoutContentHash } from "./scout.js";
import { ownerMergesOnly, type EffectiveWorkflow, type OkWorkflow } from "./workflow.js";
import { loadWorkflow, workflowError } from "./workflow-load.js";
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
  logger?: Logger;
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
  private readonly logger: Logger;
  readonly workerId: string;

  private isTicking = false;
  private policyErrorNotifiedSha: string | null = null;
  private readonly runningTasks = new Map<number, RunningTask>();
  private readonly rejectedIssueCache = new Map<number, string>(); // issueNumber -> updatedAt
  /** The workflow resolved at the start of the current tick; null until the first tick resolves one. */
  private workflow: OkWorkflow | null = null;
  private effectiveGate: GatePolicy = GatePolicySchema.parse({});
  private effectiveRequiredChecks: string[] = ["Gate"];
  private effectiveReviewRubric: string | undefined;

  constructor(deps: ReconcilerDeps) {
    this.cfg = deps.config;
    this.ledger = deps.ledger.forRepo(`${deps.config.githubOwner}/${deps.config.githubRepo}`);
    this.github = deps.github;
    this.broker = deps.broker;
    this.implementer = deps.implementer;
    this.reviewers = deps.reviewers;
    this.notifier = deps.notifier;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.workerId = deps.workerId ?? `archangel-${process.pid}`;
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

  /** Dashboard read path: the latest resolution (ok, missing or invalid) per repo, so the UI never calls GitHub. */
  private cacheWorkflow(resolved: EffectiveWorkflow, now: number): void {
    const key = `workflow:${this.ledger.repo}`;
    const json = JSON.stringify(resolved);
    if (this.ledger.getSystemState(key) !== json) this.ledger.setSystemState(key, json, now);
  }

  private async runTickInternal(now: number): Promise<void> {
    // 0. Flush durable outbox side effects (retries any labels/notifications lost on crash).
    await this.flushOutbox();

    const remoteUrl = await this.github.getRemoteUrlWithToken();
    await this.broker.ensureBareRepo(remoteUrl);
    const mainSha = await this.github.getBranchTipSha(this.cfg.defaultBranch);
    await this.backfillEvalRefs();

    // Resolve the repo's workflow (`.agents/archangel.json` at the `main` tip) against the host config.
    // Missing or invalid halts new work for this repo (fail closed); owner commands and post-merge main
    // monitoring still run.
    const resolved = await loadWorkflow(this.broker, this.cfg, this.ledger, mainSha);
    this.cacheWorkflow(resolved, now);
    const policyError = workflowError(resolved);
    if (resolved.status === "ok") {
      this.workflow = resolved;
      this.effectiveGate = resolved.gate;
      this.effectiveRequiredChecks = resolved.requiredChecks;
      this.effectiveReviewRubric = resolved.rubric;
    }

    if (resolved.status === "ok") await this.notifyWastedScouts(resolved, now);

    if (policyError) {
      if (this.policyErrorNotifiedSha !== mainSha) {
        this.policyErrorNotifiedSha = mainSha;
        this.ledger.appendAudit("config/repo_policy_invalid", null, "archangel", { mainSha, error: policyError }, now);
        this.logger.warn("config/repo_policy_invalid", `Halting new work: ${policyError}`, { repo: this.ledger.repo });
        const policy = MAIN_ESCALATION_POLICY.repo_policy_invalid;
        await this.notifier
          .notifyNeedsYou({
            issueNumber: null,
            title: `${this.cfg.githubOwner}/${this.cfg.githubRepo}: repo policy unusable at ${mainSha.slice(0, 8)}`,
            reason: policyError.slice(0, 500),
            decisionClass: formatDecisionClass(policy.decisionClass),
            recommendation: policy.recommendation,
          })
          .catch(() => undefined);
      }
      await this.processPendingCommands(mainSha, now);
      await this.reconcilePostMergeMain(mainSha, now);
      return;
    }
    this.policyErrorNotifiedSha = null;

    // 1. Process pending CLI -> Daemon handoff commands (Opus Step 6 / R5).
    await this.processPendingCommands(mainSha, now);

    // 2. Monitor post-merge main CI health & circuit breaker (isolated per merge — Opus S13).
    await this.reconcilePostMergeMain(mainSha, now);

    // 3. Intake eligible owner-authored, owner-labeled issues.
    const readyIssues = await this.github.listOpenIssuesByLabel(this.cfg.labels.readyForAgent);
    const issueMap = new Map<number, GitHubIssue>();
    for (const issue of readyIssues) {
      issueMap.set(issue.number, issue);
      await this.reconcileIntakeIssue(issue, now, mainSha);
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

    // 5. Run scheduled daily Scout workflows when repo queue is idle (V2.0).
    if (this.cfg.scouts.enabled && this.runningTasks.size === 0 && queued.length === 0) {
      try {
        await runScoutsForProject({
          config: this.cfg,
          ledger: this.ledger,
          github: this.github,
          broker: this.broker,
          workflow: this.workflow!,
          reviewers: this.reviewers,
          notifier: this.notifier,
          mainSha,
          onlyScheduled: true,
          logger: this.logger,
          now,
        });
      } catch (err) {
        this.ledger.appendAudit(
          "scout/error",
          null,
          "archangel",
          { error: err instanceof Error ? err.message : String(err) },
          now,
        );
      }
    }

    // Flush any newly enqueued outbox effects immediately.
    await this.flushOutbox();
  }

  /** One Needs You (project-level, no issue) when an auto-promoting Scout version is revoked for waste. */
  private async notifyWastedScouts(wf: OkWorkflow, now: number): Promise<void> {
    for (const scout of wf.scouts) {
      if (scout.promotion !== "auto" || !this.ledger.isScoutAutoPromoteWasted(scout.name, scout.trustHash)) continue;
      if (this.ledger.scoutWasteNoticeSent(scout.name, scout.trustHash)) continue;
      this.ledger.markScoutWasteNoticeSent(scout.name, scout.trustHash, now);
      const policy = MAIN_ESCALATION_POLICY.scout_auto_promote_revoked;
      await this.notifier
        .notifyNeedsYou({
          issueNumber: null,
          title: `${this.cfg.githubOwner}/${this.cfg.githubRepo}: Scout '${scout.name}' lost auto-promotion (3 unmerged in a row)`,
          reason: `The last 3 auto-promoted Threads from Scout '${scout.name}' ended without a merge.`,
          decisionClass: formatDecisionClass(policy.decisionClass),
          recommendation: policy.recommendation,
        })
        .catch(() => undefined);
    }
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

  /** Best-effort: pinning is bookkeeping for replay and must never block or fail a tick. */
  private async pinEval(issueNumber: number, ...shas: Array<string | null | undefined>): Promise<void> {
    for (const sha of new Set(shas)) {
      if (!sha) continue;
      try {
        await this.broker.pinEvalRef(this.ledger.repo, issueNumber, sha);
      } catch (err) {
        this.logger.warn("eval/pin_failed", err instanceof Error ? err.message : String(err), { repo: this.ledger.repo });
      }
    }
  }

  /** One-shot per repo: pin every reviewed, Attempt and merged head still fetchable, so history from before capture is kept. */
  private async backfillEvalRefs(): Promise<void> {
    const key = `eval_refs_backfilled:${this.ledger.repo}`;
    if (this.ledger.getSystemState(key)) return;
    for (const { issueNumber, sha } of this.ledger.listEvalShas()) await this.pinEval(issueNumber, sha);
    this.ledger.setSystemState(key, "1");
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
          const policy = describeEscalation(
            eff.code,
            workClassOfBranch((eff.issueNumber === null ? null : this.ledger.getThread(eff.issueNumber))?.branchName ?? ""),
          );
          await this.notifier.notifyNeedsYou({
            issueNumber: eff.issueNumber,
            title: eff.title,
            reason: eff.reason,
            decisionClass: formatDecisionClass(policy.decisionClass),
            recommendation: policy.recommendation,
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

  /**
   * A bot-applied `ready-for-agent` counts only for a proposal recorded as auto-promoted whose Scout, at
   * the current `main`, still resolves to effective `auto` promotion with the same `trustHash` that filed
   * it. A changed entry or prompt, a revocation, or a zero host cap all fall back to the owner's label.
   */
  private isValidAutoPromotion(issueNumber: number): boolean {
    const proposal = this.ledger.getScoutProposal(issueNumber);
    if (!proposal?.autoPromoted || !proposal.fileSha256) return false;
    const scout = this.workflow?.scouts.find((s) => s.name === proposal.scoutName);
    return Boolean(
      scout && scout.promotionEffective.value === "auto" && scout.trustHash === proposal.fileSha256 && !scout.revoked,
    );
  }

  private async reconcileIntakeIssue(issue: GitHubIssue, now: number, mainSha: string): Promise<void> {
    const isOwnerAuthored =
      issue.authorId === this.cfg.ownerUserId && issue.authorAssociation === "OWNER";

    // Explicit separate path for owner-promoted Scout proposals (Opus H2, H3, M1, M2):
    // NEVER weakens the owner check above; requires configured bot ID (>0), local scout_proposals
    // record, exact content hash match (blocks post-filing edits), AND owner label actor below.
    let isVerifiedBotProposal = false;
    if (!isOwnerAuthored) {
      const botId = this.cfg.githubAppBotUserId;
      if (botId !== undefined && botId > 0 && issue.authorId === botId) {
        const proposal = this.ledger.getScoutProposal(issue.number);
        if (!proposal) {
          if (this.rejectedIssueCache.get(issue.number) !== issue.updatedAt) {
            this.rejectedIssueCache.set(issue.number, issue.updatedAt);
            this.ledger.appendAudit(
              "intake/rejected_unknown_bot_issue",
              issue.number,
              issue.authorLogin,
              { authorId: issue.authorId },
              now,
            );
          }
          return;
        }
        const actualHash = scoutContentHash(issue.title, issue.body);
        if (actualHash !== proposal.contentSha256) {
          if (this.rejectedIssueCache.get(issue.number) !== issue.updatedAt) {
            this.rejectedIssueCache.set(issue.number, issue.updatedAt);
            this.ledger.appendAudit(
              "intake/rejected_edited_proposal",
              issue.number,
              issue.authorLogin,
              { expected: proposal.contentSha256.slice(0, 12), actual: actualHash.slice(0, 12) },
              now,
            );
          }
          return;
        }
        isVerifiedBotProposal = true;
      }
    }

    if (!isOwnerAuthored && !isVerifiedBotProposal) {
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
    const autoPromoted =
      !ownerLabeled && isVerifiedBotProposal && this.isValidAutoPromotion(issue.number);
    if (!ownerLabeled && !autoPromoted) {
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

    // Work class: only an owner-authored issue carrying an owner-applied `class:feature` label is a feature.
    // Scout proposals (including auto-promoted ones) and unverified labels are always bugfix.
    const workClass: WorkClass =
      isOwnerAuthored &&
      !isVerifiedBotProposal &&
      issue.labels.includes(this.cfg.labels.feature) &&
      (await this.github.verifyLabelActor(issue.number, this.cfg.labels.feature, this.cfg.ownerUserId))
        ? "feature"
        : "bugfix";

    const themeLabel = issue.labels.find((l) => l.startsWith("theme:")) ?? null;
    this.ledger.upsertThread({
      branchName: branchNameFor(workClass, issue.number),
      issueNumber: issue.number,
      title: issue.title,
      themeLabel,
      bodySha256: sha256(issue.body),
      phase: { kind: "queued" },
      mode: "autonomous",
      workflowSha256: this.workflow?.fileSha256 ?? null,
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
    const updated = this.ledger.transition(thread.issueNumber, thread.version, stepped.next, {
      nextMode: stepped.nextMode,
      effects: stepped.effects,
      ...extra,
    });
    if (updated && updated.phase.kind !== thread.phase.kind) {
      const detail =
        updated.phase.kind === "needs_you"
          ? ` (${updated.phase.code}: ${updated.phase.reason})`
          : updated.phase.kind === "done"
            ? ` (${updated.phase.outcome})`
            : "";
      const lvl = updated.phase.kind === "needs_you" ? "warn" : "info";
      this.logger[lvl](
        extra.auditTopic ?? `phase/${updated.phase.kind}`,
        `${thread.phase.kind} -> ${updated.phase.kind}${detail}`,
        { repo: this.ledger.repo, issue: thread.issueNumber },
      );
    }
    return updated;
  }

  /**
   * Owner retry (label removed or `/archangel retry`): collect the owner's reply, grant one more
   * Attempt budget, and resume. Returns null (try again next tick) if the reply cannot be fetched.
   */
  private async ownerRetry(
    thread: ThreadRecord,
    issue: GitHubIssue,
    via: "label_removed" | "comment",
    now: number,
  ): Promise<ThreadRecord | null> {
    try {
      const reply = await collectOwnerReply({
        github: this.github,
        ownerUserId: this.cfg.ownerUserId,
        issueNumber: thread.issueNumber,
        prNumber: thread.phase.kind === "needs_you" ? (thread.phase.prNumber ?? extractPrFromPhase(thread.phase)?.prNumber ?? null) : null,
        sinceMs: thread.updatedAt,
      });
      if (reply) {
        this.ledger.setOwnerReply(thread.issueNumber, reply, now);
      }
      this.ledger.grantRetryBudget(thread.issueNumber, now);
    } catch (err) {
      // Never resume without the owner's reply: retry on the next tick.
      this.logger.warn("thread/owner_reply_fetch_failed", err instanceof Error ? err.message : String(err), {
        repo: this.ledger.repo,
        issue: thread.issueNumber,
      });
      return null;
    }
    this.ledger.appendAudit("thread/owner_retry", thread.issueNumber, "owner", { via }, now);
    return this.applyMachineEvent(
      thread,
      { t: "owner_retry" },
      { bodySha256: sha256(issue.body), auditTopic: "thread/owner_retried", now },
    );
  }

  /**
   * One-tap answers to Needs You: `/archangel retry|close|handoff` as the first line of a comment by
   * `ownerUserId` on the issue or PR, posted after the Thread entered needs_you. Each comment id is
   * handled exactly once (durable in the audit log). Anyone else's `/archangel` comment (bots included,
   * so the Recap can never trigger one) is ignored with an audit row.
   * Returns the updated Thread when a command moved it, "stop" to end this tick, or null to carry on.
   */
  private async processOwnerCommands(
    thread: ThreadRecord,
    issue: GitHubIssue | undefined,
    now: number,
  ): Promise<ThreadRecord | "stop" | null> {
    if (thread.phase.kind !== "needs_you") return null;
    const prNumber = thread.phase.prNumber ?? extractPrFromPhase(thread.phase)?.prNumber ?? null;
    const places = [thread.issueNumber, ...(prNumber && prNumber !== thread.issueNumber ? [prNumber] : [])];
    const found: Array<{ where: number; c: IssueComment }> = [];
    try {
      for (const where of places) {
        for (const c of await this.github.listCommentsSince(where, thread.updatedAt)) found.push({ where, c });
      }
    } catch (err) {
      this.logger.warn("thread/owner_command_fetch_failed", err instanceof Error ? err.message : String(err), {
        repo: this.ledger.repo,
        issue: thread.issueNumber,
      });
      return null;
    }
    found.sort((a, b) => a.c.createdAt - b.c.createdAt || a.c.id - b.c.id);

    for (const { where, c } of found) {
      const firstLine = c.body.trim().split("\n")[0]!.trim();
      if (!COMMAND_LINE_RE.test(firstLine) || this.ledger.hasHandledOwnerCommand(c.id)) continue;
      if (c.userId !== this.cfg.ownerUserId) {
        this.ledger.recordOwnerCommand(c.id, thread.issueNumber, "ignored", `github:${c.userId}${c.isBot ? ":bot" : ""}`, now);
        continue;
      }
      const command = firstLine.split(/\s+/)[1]?.toLowerCase() ?? "";
      if (command === "retry") {
        if (!issue) return null;
        const retried = await this.ownerRetry(thread, issue, "comment", now);
        if (!retried) return "stop";
        this.ledger.recordOwnerCommand(c.id, thread.issueNumber, "retry", "owner", now);
        return retried;
      }
      if (command === "close") {
        const abandoned = this.applyMachineEvent(
          thread,
          { t: "owner_abandon" },
          { auditTopic: "thread/owner_abandoned", auditPayload: { via: "comment" }, now },
        );
        if (!abandoned) return "stop";
        this.ledger.recordOwnerCommand(c.id, thread.issueNumber, "close", "owner", now);
        if (prNumber) {
          try {
            await this.github.closePr(prNumber);
          } catch (err) {
            this.logger.warn("thread/owner_close_pr_failed", err instanceof Error ? err.message : String(err), {
              repo: this.ledger.repo,
              issue: thread.issueNumber,
            });
          }
        }
        return "stop";
      }
      // Handoff launches an agent in the owner's local Paseo, which the daemon cannot do on its own, and
      // parking a Thread as owner_driving with nobody driving would stall it. Record the request, point at the CLI.
      this.ledger.recordOwnerCommand(
        c.id,
        thread.issueNumber,
        command === "handoff" ? "handoff_requested" : "unknown",
        "owner",
        now,
      );
      await this.github.postComment(
        where,
        command === "handoff"
          ? `Handoff needs your local Paseo, so I left this Thread in Needs You. Run \`archangel handoff ${thread.issueNumber}\` on your machine.`
          : `Unknown command. Valid commands (first line of a comment): \`/archangel retry\` (text below it is your hint), \`/archangel close\`, \`/archangel handoff\`.`,
      );
    }
    return null;
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
      this.ledger.markDisagree(
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

    // 5. `needs_you`: an owner comment command or clearing the `needs-you` label resumes cleanly & re-snapshots bodySha (fixes S4, S15!).
    if (thread.phase.kind === "needs_you") {
      const afterCommands = await this.processOwnerCommands(thread, issue, now);
      if (afterCommands === "stop") return;
      if (afterCommands) thread = afterCommands;
    }
    if (thread.phase.kind === "needs_you") {
      // A missing label only means "owner removed it" once our own add_label has been delivered; while it is
      // still queued (GitHub error, or a race inside this tick) the Thread must keep waiting.
      if (
        issue &&
        !combinedLabels.includes(this.cfg.labels.needsYou) &&
        !this.ledger.hasPendingLabelAdd(thread.issueNumber, this.cfg.labels.needsYou)
      ) {
        const retried = await this.ownerRetry(thread, issue, "label_removed", now);
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

  /**
   * True when this project has taken `maxAutonomousStepsWithoutOwner` steps without owner input.
   * Notifies once per cap hit; any owner action resets the count and re-arms the notification.
   */
  private async autonomyCapReached(now: number): Promise<boolean> {
    const cap = this.cfg.maxAutonomousStepsWithoutOwner;
    const steps = this.ledger.autonomousStepsSinceOwner();
    const key = `autonomy_cap_notified:${this.ledger.repo}`;
    const notified = this.ledger.getSystemState(key) === "1";
    if (steps < cap) {
      if (notified) this.ledger.setSystemState(key, "0", now);
      return false;
    }
    if (!notified) {
      try {
        await this.notifier.notifyNeedsYou({
          issueNumber: null,
          title: `Autonomy cap reached for ${this.ledger.repo}`,
          reason: `${steps} autonomous steps (cap ${cap}) since you were last heard from; no new Attempts or merges will start.`,
          decisionClass: formatDecisionClass(MAIN_ESCALATION_POLICY.autonomy_cap.decisionClass),
          recommendation: MAIN_ESCALATION_POLICY.autonomy_cap.recommendation,
        });
        this.ledger.setSystemState(key, "1", now);
        this.ledger.appendAudit("autonomy/cap_reached", null, "archangel", { steps, cap }, now);
      } catch (err) {
        this.logger.warn("autonomy/cap_notify_failed", err instanceof Error ? err.message : String(err), {
          repo: this.ledger.repo,
        });
      }
    }
    return true;
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
    if (await this.autonomyCapReached(now)) {
      return false;
    }
    if (thread.implementCount >= this.cfg.maxImplementAttemptsPerThread + thread.retryGrants) {
      this.applyMachineEvent(
        thread,
        {
          t: "escalate",
          code: "max_attempts",
          reason: `Reached max implement attempts (${thread.implementCount}/${this.cfg.maxImplementAttemptsPerThread + thread.retryGrants}).`,
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
    this.ledger.recordAttemptProvenance(attempt.id, {
      promptSha256: promptTemplateSha(kind === "revise" ? "revise" : kind === "rebase" ? "rebase" : "implement", workClassOfBranch(thread.branchName)),
      workflowSha256: this.workflow?.fileSha256 ?? null,
    });
    if (kind === "implement") await this.pinEval(thread.issueNumber, fromSha);

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
              gate: this.effectiveGate,
              ownerReply: workingThread.ownerReply,
              workClass: workClassOfBranch(workingThread.branchName),
            })
          : kind === "revise"
            ? buildRevisionPrompt({
                issueNumber: issue.number,
                title: issue.title,
                body: issue.body,
                gateViolations,
                structuredFindings,
                gate: this.effectiveGate,
                ownerReply: workingThread.ownerReply,
                workClass: workClassOfBranch(workingThread.branchName),
              })
            : buildRebasePrompt({
                issueNumber: issue.number,
                title: issue.title,
                baseBranch: this.cfg.defaultBranch,
                gate: this.effectiveGate,
                ownerReply: workingThread.ownerReply,
              });

      const result: ImplementResult = await this.implementer.run({
        issueNumber: issue.number,
        cloneDir,
        prompt,
        abortController: task.abortController,
        maxTurns: this.cfg.implementMaxTurns,
        timeoutMs: this.cfg.implementTimeoutMs,
        maxBudgetUsd: reservedUsd,
        preferVendors: kind === "implement" ? undefined : workingThread.implementerVendors,
      });

      actualCostUsd = result.costUsd;
      transcriptPath = result.transcriptPath;
      this.ledger.recordAttemptProvenance(attemptId, { provider: result.runBy?.provider ?? null, model: result.runBy?.model ?? null });
      if (result.providersUsed && result.providersUsed.length > 0) {
        this.ledger.recordImplementerVendors(workingThread.issueNumber, result.providersUsed);
      }

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
              workClassOfBranch(workingThread.branchName),
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
        workClassOfBranch(workingThread.branchName),
      );

      await this.pinEval(workingThread.issueNumber, validation.headSha);

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
        if (kind === "implement" && latest.revisionCount < this.cfg.maxRevisionsPerThread + latest.retryGrants) {
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

      // Detect no-op revisions so we escalate instead of re-pushing an identical SHA back into awaiting_gate.
      if (kind === "revise" && validation.headSha === fromSha) {
        this.ledger.finishAttempt(attemptId, {
          status: "failed",
          headSha: validation.headSha,
          costUsd: actualCostUsd,
          reservedUsd,
          transcriptPath,
          errorMessage: "Revision attempt produced no new changes (identical SHA)",
        });
        const latest = this.ledger.getThread(workingThread.issueNumber);
        if (latest && latest.version === workingThread.version) {
          this.applyMachineEvent(
            latest,
            {
              t: "attempt_failed",
              code: "review_vetoed",
              reason: "Revision attempt produced no new changes (identical SHA) — needs owner review",
            },
            { auditTopic: "thread/needs_you" },
          );
        }
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
      this.logger.info(
        "thread/pr_pushed",
        `Pushed ${workingThread.branchName} @ ${validation.headSha.slice(0, 8)} -> PR #${pr.number}`,
        { repo: this.ledger.repo, issue: issue.number },
      );

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

    // GitHub never runs pull_request workflows on a PR that conflicts with its base, so the required checks would
    // never appear. Resolve the conflict first; do not let the missing checks time out.
    if (pr.mergeable === false && thread.mode === "autonomous") {
      const cleanMergeTree = await this.broker.isMergeTreeClean(mainSha, pr.headSha);
      await this.rebaseOntoMain(thread, pr, issue, mainSha, cleanMergeTree, [
        { code: "merge_conflict", message: "PR conflicts with the base branch; the Gate cannot run until it is rebased" },
      ] as ReturnType<typeof computeBlockers>, now);
      return;
    }
    // GitHub is still computing mergeability (and has not started workflows yet): keep waiting, and restart the
    // missing-checks clock so this wait is never counted as checks that failed to appear.
    if (pr.mergeable === null) {
      this.applyMachineEvent(
        thread,
        { t: "head_moved", pr: { prNumber: pr.number, headSha: pr.headSha, baseSha: pr.baseSha }, now },
        { now },
      );
      return;
    }

    const checks = await this.github.getCheckRunsForRef(pr.headSha);
    const verdict = classifyGate({
      requiredChecks: this.effectiveRequiredChecks,
      checks,
      since: thread.phase.since,
      now,
      graceMs: this.cfg.gateStartGraceMs,
      timeoutMs: this.cfg.gateTimeoutMs,
    });

    switch (verdict.status) {
      case "missing_grace":
      case "pending":
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
          thread.revisionCount < this.cfg.maxRevisionsPerThread + thread.retryGrants
        ) {
          if (this.runningTasks.size >= this.cfg.maxConcurrentThreads) return; // all slots busy: wait, do not escalate
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
    const excludeVendors = thread.implementerVendors;
    const requiredVendors = resolveRequiredReviewers(this.cfg, excludeVendors);
    if (requiredVendors.length < 2) {
      const escalated = this.applyMachineEvent(
        thread,
        {
          t: "escalate",
          code: "review_outage",
          reason: `Insufficient independent reviewers (${requiredVendors.length}/2 available; implementer vendors=${excludeVendors.join(",") || "unknown"})`,
        },
        { auditTopic: "thread/needs_you", now },
      );
      if (escalated) {
        await this.postRecapSafe(escalated, pr, [
          {
            code: "insufficient_independent_reviewers",
            message: `Only ${requiredVendors.length} independent reviewer(s) available after failover`,
          },
        ]);
      }
      return;
    }
    const haveVendors = new Set(existing.map((r) => r.vendor));
    const missingVendors = requiredVendors.filter((v) => !haveVendors.has(v));

    if (missingVendors.length > 0) {
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
          skipVendors: [...haveVendors],
          excludeVendors,
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
            provider: r.provider ?? null,
            model: r.model ?? null,
            promptSha256: r.promptSha256 ?? null,
            rubricSha256: rubricSha(this.effectiveReviewRubric),
            workflowSha256: this.workflow?.fileSha256 ?? null,
            now,
          });
        }
        await this.pinEval(thread.issueNumber, headSha, pr.baseSha);
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

      if (thread.mode === "autonomous" && thread.revisionCount < this.cfg.maxRevisionsPerThread + thread.retryGrants) {
        if (this.runningTasks.size >= this.cfg.maxConcurrentThreads) return; // all slots busy: wait, do not escalate
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

  /**
   * Gets a conflicting or stale PR back onto main: a deterministic Broker rebase when the merge-tree is clean (0 LLM tokens),
   * else an LLM rebase Attempt, bounded by maxRebasesPerThread; escalates `merge_conflict` once that is exhausted.
   * Shared by landing (computed blockers) and the Gate wait (GitHub reports the PR as conflicting).
   */
  private async rebaseOntoMain(
    thread: ThreadRecord,
    pr: GitHubPr,
    issue: GitHubIssue | undefined,
    mainSha: string,
    cleanMergeTree: boolean,
    blockers: ReturnType<typeof computeBlockers>,
    now: number,
  ): Promise<void> {
    if (
      cleanMergeTree &&
      thread.rebaseCount < this.cfg.maxRebasesPerThread
    ) {
      const rebased = await this.broker.rebaseCleanOntoMain(thread.issueNumber, mainSha, pr.headSha);
      if (rebased.ok) {
        const remoteUrl = await this.github.getRemoteUrlWithToken();
        await this.broker.pushFactoryBranch(thread.branchName, rebased.headSha, remoteUrl);
        this.ledger.recordPushedSha(rebased.headSha, thread.issueNumber, "broker", now);
        const moved = this.applyMachineEvent(
          thread,
          {
            t: "head_moved",
            pr: { prNumber: pr.number, headSha: rebased.headSha, baseSha: mainSha },
            now,
          },
          {
            incRebase: true,
            auditTopic: "broker/deterministic_rebase",
            auditPayload: { oldSha: pr.headSha, newSha: rebased.headSha, mainSha },
            now,
          },
        );
        if (moved) {
          this.logger?.info(
            "broker/deterministic_rebase",
            `Rebased ${thread.branchName} onto ${mainSha.slice(0, 8)} -> ${rebased.headSha.slice(0, 8)} (0 LLM tokens)`,
            { repo: this.ledger.repo, issue: thread.issueNumber },
          );
        }
        return;
      }
    }
    if (issue && thread.rebaseCount < this.cfg.maxRebasesPerThread) {
      if (this.runningTasks.size >= this.cfg.maxConcurrentThreads) return; // all slots busy: wait, do not escalate
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

    // Feature Threads never merge autonomously: they always take the owner-merge (shadow_ready) path.
    const isFeature = workClassOfBranch(thread.branchName) === "feature";
    const ownerMergesOnlyNow = ownerMergesOnly(this.workflow!, workClassOfBranch(thread.branchName));
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
      requiredReviewers: resolveRequiredReviewers(this.cfg, thread.implementerVendors),
      mergeTreeClean,
      autoMergesToday: this.ledger.getAutoMergeCountToday(now),
      maxAutoMergesPerDay: this.cfg.maxAutoMergesPerDay,
      shadowMode: ownerMergesOnlyNow,
      featureThread: isFeature,
    });

    // In Shadow Mode, don't burn a paid LLM rebase just because `main` moved while clean merge-tree holds;
    // record the shadow verdict with a note so owner can inspect/merge directly (Opus review).
    const shadowReadyWithBehind =
      ownerMergesOnlyNow &&
      blockers.every((b) => b.code === "shadow_mode_active" || b.code === "branch_behind_main") &&
      blockers.some((b) => b.code === "shadow_mode_active");

    // Handle merge conflicts or stale base: prefer deterministic Broker rebase when merge-tree is clean (0 LLM tokens!).
    if (
      !shadowReadyWithBehind &&
      blockers.some((b) => b.code === "merge_conflict" || b.code === "branch_behind_main") &&
      thread.mode === "autonomous"
    ) {
      await this.rebaseOntoMain(
        thread,
        pr,
        issue,
        mainSha,
        mergeTreeClean && !blockers.some((b) => b.code === "merge_conflict"),
        blockers,
        now,
      );
      return;
    }

    // Shadow Mode: ready except for shadow_mode_active (and optional branch_behind_main with clean merge-tree).
    if (isShadowReady(blockers) || shadowReadyWithBehind) {
      await this.pinEval(thread.issueNumber, pr.headSha, pr.baseSha);
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

    if (isFeature) {
      return; // Defence in depth: unreachable while ownerMergesOnly forces a shadow_mode_active blocker.
    }
    if (await this.autonomyCapReached(now)) {
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

    await this.pinEval(thread.issueNumber, pr.headSha, pr.baseSha);
    const mergeRow = this.ledger.recordMerge({
      issueNumber: thread.issueNumber,
      prNumber: pr.number,
      headSha: pr.headSha,
      squashSha,
      shadowOnly: false,
      mainRequired: this.effectiveRequiredChecks.filter((n) => n !== "Gate"),
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
   * Uses `MainWatch`, the non-Gate checks recorded on the merge row, tracks exact rerun IDs,
   * enforces watch timeout, and isolates each merge in its own try/catch.
   */
  private async reconcilePostMergeMain(mainSha: string, now: number): Promise<void> {
    const pending = this.ledger.listPendingPostMergeChecks();
    if (pending.length === 0) return;

    // Each merge is watched against the checks recorded when it merged, so an invalid or edited
    // workflow can never leave a red main unwatched.
    for (const m of pending) {
      if (m.mainRequired.length === 0) {
        // Only rows from before checks were recorded can get here. Nothing can be verified, so close the row loudly.
        this.ledger.updateMergeMainWatch(m.id, { kind: "timed_out", at: now });
        this.ledger.appendAudit("post_merge/missing_required_checks", m.issueNumber, "archangel", { mergeId: m.id }, now);
        continue;
      }
      try {
        await this.reconcileOnePostMerge(m, m.mainRequired, mainSha, now);
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
          decisionClass: formatDecisionClass(MAIN_ESCALATION_POLICY.red_main_reverted.decisionClass),
          recommendation: MAIN_ESCALATION_POLICY.red_main_reverted.recommendation,
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
          decisionClass: formatDecisionClass(MAIN_ESCALATION_POLICY.red_main_manual.decisionClass),
          recommendation: MAIN_ESCALATION_POLICY.red_main_manual.recommendation,
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
    let gateProof: GateProof | null = null;
    try {
      const gate = (await this.github.getCheckRunsForRef(pr.headSha)).find(
        (c) => c.name === "Gate" && c.appSlug === "github-actions" && c.status === "completed",
      );
      if (gate) gateProof = await this.github.getGateProof(gate.id, pr.headSha);
    } catch (err) {
      this.logger.warn("recap/gate_proof_unavailable", err instanceof Error ? err.message : String(err), {
        repo: this.ledger.repo,
        issue: thread.issueNumber,
      });
    }
    await this.github.upsertRecapComment(
      pr.number,
      renderRecapComment({
        thread,
        reviews,
        blockers,
        wouldMerge: opts.wouldMerge,
        gateProof,
      }),
    );
  }
}
