import { tryParseJson } from "../core/json.js";
import {
  EscalationCodeSchema,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_MAX_MS,
  OUTBOX_MAX_ATTEMPTS,
  OutboxEffectSchema,
} from "../core/thread-machine.js";
import { findingCategory, type CorrectionCounts } from "../core/corrections.js";
import { FACTORY_OUTCOMES, classifyFactoryOutcome, type FactoryOutcome, type FactoryRetryOutcome } from "../core/factory-retry.js";
import { PocStateSchema, stepPoc, type PocEvent, type PocState } from "../core/poc-machine.js";
import { PitchStateSchema, stepPitch, type PitchEvent, type PitchState, type PitchStateKind } from "../core/pitch-machine.js";
import { CommandStateSchema, stepCommand, type CommandEvent } from "../core/command-machine.js";
import { describeEscalation } from "../core/escalations.js";
import { planSha256 } from "../core/plan.js";
import { workClassOfBranch, type WorkClass } from "../core/work-class.js";
import type { DigestInput } from "../core/digest.js";
import { readCodexUsage, type AccountLedger } from "../core/accounts.js";
import type { Account } from "../config.js";
import fs from "node:fs";
import path from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  MainWatchSchema,
  PhaseSchema,
  stepPhase,
  type AttemptKind,
  type EscalationCode,
  type MainWatch,
  type Mode,
  type OutboxEffect,
  type Phase,
  type PhaseKind,
  type ValidatedPhase,
} from "../core/thread-machine.js";
import { parseAttemptInput, type AttemptInput } from "../core/attempt-input.js";
import { emit } from "../core/telemetry.js";
import type { TelemetryTags } from "../core/telemetry-events.js";
import {
  LEDGER_SCHEMA_SQL,
  type AttemptErrorCategory,
  type AttemptRecord,
  type AuditLogEntry,
  type DaemonCommandRecord,
  type MergeRecord,
  type OutboxRecord,
  type ReviewFinding,
  type ReviewRecord,
  type ReviewerVendor,
  type ReviewVerdict,
  type ScoutProposalRecord,
  type SignalRecord,
  type SignalTaint,
  type ThreadRecord,
  type TriageSummary,
} from "./schema.js";

export function formatDayKey(ts: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}


export const OWNER_REPLY_MAX_CHARS = 4000;

export interface OutcomeMetrics {
  mergedFixes: number;
  /** Metered USD only (attempts.cost_usd + reviews.cost_usd); subscription CLI runs record $0. */
  meteredUsdTotal: number;
  costUsdPerFix: number | null;
  attemptsPerFix: number | null;
  attemptMinutesPerFix: number | null;
  reverts: number;
  revertsPerFix: number | null;
  /** Attempts beyond the first, per merged fix. */
  reworkAttemptsTotal: number;
  reworkAttemptsPerFix: number | null;
  vendorAgreement: Record<string, { approvedMerges: number; undisputed: number; rate: number | null }>;
}

/** Per-stage figures for one repo (V4 Pipeline view). Numbers and fixed enums only. */
/** The number of most recent decided pitches the promotion rate is taken over. */
export const PITCH_RATE_WINDOW = 6;

export interface PitchMetrics {
  filed: number;
  promoted: number;
  declined: number;
  expired: number;
  open: number;
  vetoed: number;
  /** Of the last PITCH_RATE_WINDOW decided pitches (fewer if fewer exist): how many, and how many were promoted. */
  lastDecided: number;
  lastDecidedPromoted: number;
}

export interface StageMetrics {
  windowDays: number;
  intake: { queued: number; oldestQueuedAgeSec: number | null; rejections: Record<string, number> };
  scouts: Record<
    string,
    { runs: number; secretsBlocked: number; filed: number; becameThread: number; merged: number; reverted: number }
  >;
  promotion: { autoPromotionsLast24h: number; autoPromotionsInWindow: number };
  pitches: PitchMetrics;
  workClass: Record<WorkClass, { threads: number; merged: number; attemptsPerMerge: number | null }>;
  gate: { attempts: { total: number; succeeded: number; failed: number }; escalations: Record<string, number> };
  review: { byVendor: Record<string, { approve: number; veto: number }>; outages: number };
  landing: { autoMerged: number; ownerMerged: number; reverts: number; disagreements: number; autonomyCapHits: number };
  needsYou: { byDecisionClass: Record<string, number> };
  /** Threads split by the workflow file version stamped on them ("none" for Threads from before stamping). */
  byWorkflowSha: Record<string, { threads: number; merged: number; reverted: number }>;
  /** Factory retries in the window, by outcome and by the escalation code they answered. */
  factoryRetries: { total: number; byOutcome: Record<FactoryOutcome, number>; byCode: Record<string, Record<FactoryOutcome, number>> };
}

/** Consecutive unmerged auto-promoted Threads of one Scout version that revoke its auto-promotion. */
export const SCOUT_WASTE_STREAK = 3;

export const HEALTH_WINDOW_MS = 86_400_000;
/** This many survived errors of one class in 24h raise a Needs You. */
export const HEALTH_FAULT_THRESHOLD = 3;
export interface HealthFault {
  repo: string;
  category: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  recent24h: number;
  lastError: string;
}

export class Ledger {
  private readonly db: Database;
  private readonly timeZone: string;
  readonly repo: string;

  constructor(
    dbPath: string,
    opts: { repo?: string; timeZone?: string; readonly?: boolean } = {},
  ) {
    if (!opts.readonly && dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath, opts.readonly ? { readonly: true } : { create: true, readwrite: true });
    this.repo = opts.repo ?? "default";
    this.timeZone = opts.timeZone ?? "America/New_York";
    if (!opts.readonly) {
      migrateOutbox(this.db);
      this.dropLegacyDaemonCommands();
      this.db.exec(LEDGER_SCHEMA_SQL);
      const cols = this.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "implementer_vendors_json")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN implementer_vendors_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!cols.some((c) => c.name === "owner_reply")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN owner_reply TEXT");
      }
      if (!cols.some((c) => c.name === "workflow_sha256")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN workflow_sha256 TEXT");
      }
      if (!cols.some((c) => c.name === "retry_grants")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN retry_grants INTEGER NOT NULL DEFAULT 0");
      }
      if (!cols.some((c) => c.name === "factory_retries")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN factory_retries INTEGER NOT NULL DEFAULT 0");
        this.db.exec("ALTER TABLE threads ADD COLUMN factory_guidance TEXT");
      }
      if (!cols.some((c) => c.name === "factory_triage")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN factory_triage TEXT CHECK (factory_triage IN ('pending', 'done'))");
      }
      const addCols = (table: string, cols: string[], type = "TEXT") => {
        const have = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        for (const c of cols) if (!have.includes(c)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${type}`);
      };
      addCols("attempts", ["duration_ms", "peak_rss_kb"], "INTEGER");
      addCols("attempts", ["provider", "model", "account_id", "compute", "prompt_sha256", "workflow_sha256", "error_category", "from_sha", "input_json"]);
      addCols("reviews", ["provider", "model", "account_id", "prompt_sha256", "rubric_sha256", "workflow_sha256"]);
      // Cooldowns are per account now (an implicit account's id is its provider name); the per-provider table is gone.
      this.db.exec("DROP TABLE IF EXISTS provider_cooldowns");
      const mergeCols = this.db.prepare("PRAGMA table_info(merges)").all() as Array<{ name: string }>;
      if (!mergeCols.some((c) => c.name === "main_required_json")) {
        this.db.exec("ALTER TABLE merges ADD COLUMN main_required_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!cols.some((c) => c.name === "issue_body")) this.db.exec("ALTER TABLE threads ADD COLUMN issue_body TEXT");
      const spCols = this.db.prepare("PRAGMA table_info(scout_proposals)").all() as Array<{ name: string }>;
      if (!spCols.some((c) => c.name === "file_sha256")) {
        this.db.exec("ALTER TABLE scout_proposals ADD COLUMN file_sha256 TEXT");
      }
      if (!spCols.some((c) => c.name === "auto_promoted")) {
        this.db.exec("ALTER TABLE scout_proposals ADD COLUMN auto_promoted INTEGER NOT NULL DEFAULT 0");
      }
    } else {
      this.db.exec("PRAGMA busy_timeout = 5000");
    }
  }

  /**
   * Ends a held-back escalation: marks triage done and queues the Needs You effects (label and notification) that were held
   * back, in one step, with the factory actor's audit row saying why.
   */
  releaseFactoryTriage(issueNumber: number, effects: OutboxEffect[], payload: unknown, now = Date.now()): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE threads SET factory_triage = 'done', updated_at = ? WHERE repo = ? AND issue_number = ?").run(now, this.repo, issueNumber);
      for (const eff of effects) {
        this.db.prepare(`INSERT INTO outbox (repo, effect_json, created_at) VALUES (?, ?, ?)`).run(this.repo, JSON.stringify(eff), now);
      }
      this.appendAudit("factory/escalated", issueNumber, "factory", payload, now);
    });
    tx();
  }

  /** Every factory retry in this repo (oldest first) with its outcome, decided by Ledger mechanics and owner actions only. */
  factoryRetryOutcomes(opts: { afterAuditId?: number; repo?: string } = {}): FactoryRetryOutcome[] {
    const repo = opts.repo ?? this.repo;
    const rows = this.db
      .prepare(`SELECT id, ts, issue_number, payload_json FROM audit_log WHERE repo = ? AND topic = 'factory/retry' AND id > ? ORDER BY id ASC`)
      .all(repo, opts.afterAuditId ?? 0) as Array<{ id: number; ts: number; issue_number: number; payload_json: string }>;
    const after = this.db.prepare(
      `SELECT SUM(actor = 'owner') AS owner, SUM(topic = 'escalation/raised') AS escalated FROM audit_log WHERE repo = ? AND issue_number = ? AND id > ?`,
    );
    const out: FactoryRetryOutcome[] = [];
    for (const r of rows) {
      const rawPayload = tryParseJson(r.payload_json);
      if (!rawPayload.ok || typeof rawPayload.value !== "object" || rawPayload.value === null) continue;
      const parsed = EscalationCodeSchema.safeParse((rawPayload.value as { code?: unknown }).code);
      if (!parsed.success) continue;
      const code = parsed.data;
      const thread = this.getThread(r.issue_number, repo);
      if (!thread) continue;
      const merges = this.listMergesFor(r.issue_number, repo).filter((m) => !m.shadowOnly || m.disagreed);
      const seen = after.get(repo, r.issue_number, r.id) as { owner: number | null; escalated: number | null };
      out.push({
        auditId: r.id,
        issueNumber: r.issue_number,
        code,
        at: r.ts,
        outcome: classifyFactoryOutcome({
          phaseKind: thread.phase.kind,
          doneOutcome: thread.phase.kind === "done" ? thread.phase.outcome : null,
          reverted: (thread.phase.kind === "done" && thread.phase.outcome === "reverted") || merges.some((m) => m.mainWatch.kind === "red"),
          disputed: merges.some((m) => m.disagreed),
          ownerActedAfter: (seen.owner ?? 0) > 0,
          escalatedAfter: (seen.escalated ?? 0) > 0,
        }),
      });
    }
    return out;
  }

  /** Factory retries this repo started in the 24 hours before `now`. */
  factoryRetriesInLast24h(now = Date.now(), repo = this.repo): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE repo = ? AND topic = 'factory/retry' AND ts > ?").get(repo, now - 86_400_000) as { n: number }
    ).n;
  }

  /** The latest auto-off of factory retry for this repo: the audit row id and the workflow file version it tripped under. */
  lastFactoryAutoOff(repo = this.repo): { auditId: number; workflowSha: string } | null {
    const r = this.db
      .prepare(`SELECT id, payload_json FROM audit_log WHERE repo = ? AND topic = 'factory/auto_off' ORDER BY id DESC LIMIT 1`)
      .get(repo) as { id: number; payload_json: string } | undefined;
    if (!r) return null;
    const raw = tryParseJson(r.payload_json);
    if (!raw.ok || typeof raw.value !== "object" || raw.value === null) return { auditId: r.id, workflowSha: "" };
    return { auditId: r.id, workflowSha: String((raw.value as { workflowSha?: unknown }).workflowSha ?? "") };
  }

  recordFactoryAutoOff(workflowSha: string, why: string, now = Date.now()): void {
    this.appendAudit("factory/auto_off", null, "archangel", { workflowSha, why }, now);
  }

  /**
   * Spends the Thread's factory retry, atomically: refused when this Thread already used its allowance, when the owner has
   * acted on it (a reply or a retry ends factory involvement for good), or when the repo already spent its daily allowance.
   * The audit rows are written by the `factory` actor, which never resets the autonomy cap (only `owner` rows do).
   */
  claimFactoryRetry(
    issueNumber: number,
    input: { code: string; guidance: string | null; perThread: number; perRepoPerDay: number },
    now = Date.now(),
  ): boolean {
    const tx = this.db.transaction((): boolean => {
      const row = this.db
        .prepare("SELECT factory_retries, retry_grants, owner_reply FROM threads WHERE repo = ? AND issue_number = ?")
        .get(this.repo, issueNumber) as { factory_retries: number; retry_grants: number; owner_reply: string | null } | undefined;
      if (!row || row.factory_retries >= input.perThread || row.retry_grants > 0 || row.owner_reply !== null) return false;
      const today = this.db
        .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE repo = ? AND topic = 'factory/retry' AND ts > ?")
        .get(this.repo, now - 86_400_000) as { n: number };
      if (today.n >= input.perRepoPerDay) return false;
      this.db
        .prepare("UPDATE threads SET factory_retries = factory_retries + 1, factory_guidance = ?, updated_at = ? WHERE repo = ? AND issue_number = ?")
        .run(input.guidance, now, this.repo, issueNumber);
      this.appendAudit("factory/retry", issueNumber, "factory", { code: input.code }, now);
      return true;
    });
    return tx.immediate();
  }

  forRepo(repo: string): Ledger {
    const view = Object.create(Ledger.prototype) as Ledger;
    Object.assign(view, { db: this.db, timeZone: this.timeZone, repo });
    return view;
  }

  close(): void {
    this.db.close();
  }


  acquireDaemonLock(ownerId: string, staleMs: number, now = Date.now()): boolean {
    const tx = this.db.transaction((): boolean => {
      const existing = this.getSystemState("daemon_lock");
      if (existing) {
        const raw = tryParseJson(existing);
        if (!raw.ok || typeof raw.value !== "object" || raw.value === null) return false;
        const parsed = raw.value as { ownerId?: unknown; heartbeatAt?: unknown };
        if (typeof parsed.heartbeatAt !== "number" || !Number.isFinite(parsed.heartbeatAt)) {
          return false;
        }
        if (parsed.ownerId !== ownerId && now - parsed.heartbeatAt < staleMs) {
          return false;
        }
      }
      this.setSystemState("daemon_lock", JSON.stringify({ ownerId, pid: process.pid, heartbeatAt: now }), now);
      return true;
    });
    return tx.immediate();
  }

  /** Refreshes the lock if this daemon still owns it. False means the lock is gone, unreadable or another daemon's: the caller must stop. */
  heartbeatDaemonLock(ownerId: string, now = Date.now()): boolean {
    const tx = this.db.transaction((): boolean => {
      const existing = this.getSystemState("daemon_lock");
      if (!existing) return false;
      const raw = tryParseJson(existing);
      if (!raw.ok || typeof raw.value !== "object" || raw.value === null) return false;
      const owner = (raw.value as { ownerId?: unknown }).ownerId;
      if (owner !== ownerId) return false;
      this.setSystemState("daemon_lock", JSON.stringify({ ownerId, pid: process.pid, heartbeatAt: now }), now);
      return true;
    });
    return tx.immediate();
  }

  releaseDaemonLock(ownerId: string): void {
    const tx = this.db.transaction(() => {
      const existing = this.getSystemState("daemon_lock");
      if (!existing) return;
      const raw = tryParseJson(existing);
      if (!raw.ok || typeof raw.value !== "object" || raw.value === null) return;
      const parsed = raw.value as { ownerId?: unknown };
      if (parsed.ownerId === ownerId) {
        this.db.prepare(`DELETE FROM system_state WHERE key = 'daemon_lock'`).run();
      }
    });
    tx.immediate();
  }

  /** Last daemon heartbeat (ms), or null when no lock row exists (never started, or stopped cleanly). */
  daemonHeartbeatAt(): number | null {
    const existing = this.getSystemState("daemon_lock");
    if (!existing) return null;
    const raw = tryParseJson(existing);
    if (!raw.ok || typeof raw.value !== "object" || raw.value === null) return null;
    const at = (raw.value as { heartbeatAt?: unknown }).heartbeatAt;
    return typeof at === "number" ? at : null;
  }

  isDaemonActive(staleMs: number, now = Date.now()): boolean {
    const existing = this.getSystemState("daemon_lock");
    if (!existing) return false;
    const raw = tryParseJson(existing);
    if (!raw.ok || typeof raw.value !== "object" || raw.value === null) return true;
    const at = (raw.value as { heartbeatAt?: unknown }).heartbeatAt;
    if (typeof at !== "number") return true;
    return now - at < staleMs;
  }


  upsertThread(input: {
    issueNumber: number;
    repo?: string;
    title: string;
    themeLabel?: string | null;
    bodySha256: string;
    branchName?: string;
    phase?: Phase;
    mode?: Mode;
    workflowSha256?: string | null;
    /** The issue text at intake, kept for replay and eval. */
    issueBody?: string | null;
    now?: number;
  }): ThreadRecord {
    const repo = input.repo ?? this.repo;
    const now = input.now ?? Date.now();
    const existing = this.getThread(input.issueNumber, repo);
    if (existing) {
      this.db
        .prepare(
          `UPDATE threads SET title = ?, theme_label = ?, updated_at = ? WHERE repo = ? AND issue_number = ?`,
        )
        .run(input.title, input.themeLabel ?? existing.themeLabel, now, repo, input.issueNumber);
      return this.getThread(input.issueNumber, repo)!;
    }

    const phase: Phase = PhaseSchema.parse(input.phase ?? { kind: "queued" });
    const branchName = input.branchName ?? `factory/${input.issueNumber}`;
    this.db
      .prepare(
        `INSERT INTO threads (
          repo, issue_number, title, theme_label, body_sha256, phase_json, version, mode, branch_name, workflow_sha256, issue_body, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo,
        input.issueNumber,
        input.title,
        input.themeLabel ?? null,
        input.bodySha256,
        JSON.stringify(phase),
        input.mode ?? "autonomous",
        branchName,
        input.workflowSha256 ?? null,
        input.issueBody ?? null,
        now,
        now,
      );
    this.appendAudit(
      "thread/created",
      input.issueNumber,
      "archangel",
      { title: input.title, branchName, bodySha256: input.bodySha256 },
      now,
      repo,
    );
    return this.getThread(input.issueNumber, repo)!;
  }

  getThread(issueNumber: number, repo = this.repo): ThreadRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM threads WHERE repo = ? AND issue_number = ?`)
      .get(repo, issueNumber) as Record<string, unknown> | undefined;
    return row ? mapThread(row) : null;
  }

  listThreads(states?: PhaseKind[], repo: string | null = this.repo): ThreadRecord[] {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (repo !== null) {
      where.push("repo = ?");
      params.push(repo);
    }
    if (states && states.length > 0) {
      where.push(`state IN (${states.map(() => "?").join(",")})`);
      params.push(...states);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM threads ${clause} ORDER BY repo ASC, issue_number ASC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(mapThread);
  }

  listAllThreads(states?: PhaseKind[]): ThreadRecord[] {
    return this.listThreads(states, null);
  }

  /**
   * Compare-and-set transition: atomically updates `phase_json`, increments `version`,
   * updates optional counters/mode/bodySha/summary, and enqueues durable `outbox` side effects.
   * Returns `null` if another transition won (`version` mismatch), preventing blind overwrites!
   */
  transition(
    issueNumber: number,
    expectedVersion: number,
    nextPhase: ValidatedPhase,
    opts: {
      nextMode?: Mode;
      effects?: OutboxEffect[];
      bodySha256?: string;
      lastSummary?: string | null;
      incImplement?: boolean;
      incRevision?: boolean;
      incRebase?: boolean;
      ownerReply?: string | null;
      grantRetryBudget?: boolean;
      /** Set in the same step as the phase change, so a held-back escalation can never be left without its marker. */
      factoryTriage?: "pending" | "done";
      auditTopic?: string;
      auditActor?: "archangel" | "owner";
      auditPayload?: unknown;
      extraAudits?: Array<{ topic: string; actor: "archangel" | "owner" | "factory"; payload: unknown }>;
      now?: number;
      repo?: string;
    } = {},
  ): ThreadRecord | null {
    const repo = opts.repo ?? this.repo;
    const now = opts.now ?? Date.now();
    const validated = PhaseSchema.parse(nextPhase);
    const replyText =
      opts.ownerReply !== undefined
        ? opts.ownerReply && opts.ownerReply.trim()
          ? opts.ownerReply.trim().slice(0, OWNER_REPLY_MAX_CHARS)
          : null
        : undefined;

    const tx = this.db.transaction((): ThreadRecord | null => {
      const sets: string[] = ["phase_json = ?", "version = version + 1", "updated_at = ?"];
      const vals: SQLQueryBindings[] = [JSON.stringify(validated), now];

      if (opts.nextMode !== undefined) {
        sets.push("mode = ?");
        vals.push(opts.nextMode);
      }
      if (opts.bodySha256 !== undefined) {
        sets.push("body_sha256 = ?");
        vals.push(opts.bodySha256);
      }
      if (opts.lastSummary !== undefined) {
        sets.push("last_summary = ?");
        vals.push(opts.lastSummary);
      }
      if (opts.incImplement) sets.push("implement_count = implement_count + 1");
      if (opts.incRevision) sets.push("revision_count = revision_count + 1");
      if (opts.incRebase) sets.push("rebase_count = rebase_count + 1");
      if (replyText !== undefined) {
        sets.push("owner_reply = ?");
        vals.push(replyText);
      }
      if (opts.grantRetryBudget) {
        sets.push("retry_grants = retry_grants + 1", "factory_guidance = NULL");
      }
      if (opts.factoryTriage !== undefined) {
        sets.push("factory_triage = ?");
        vals.push(opts.factoryTriage);
      }

      vals.push(repo, issueNumber, expectedVersion);
      const res = this.db
        .prepare(
          `UPDATE threads SET ${sets.join(", ")} WHERE repo = ? AND issue_number = ? AND version = ?`,
        )
        .run(...vals);

      if (res.changes !== 1) {
        return null;
      }

      for (const eff of opts.effects ?? []) {
        this.db
          .prepare(`INSERT INTO outbox (repo, effect_json, created_at) VALUES (?, ?, ?)`)
          .run(repo, JSON.stringify(eff), now);
      }

      if (replyText !== undefined) {
        this.appendAudit("thread/owner_reply", issueNumber, "owner", { chars: replyText?.length ?? 0 }, now, repo);
      }
      // Phase entry history: every transition's audit row carries the entered phase kind; a transition with no audit topic gets a `thread/phase_entered` row.
      const entered = { phase: validated.kind };
      if (opts.auditTopic) {
        const payload = opts.auditPayload ?? { next: validated.kind };
        const body = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? { ...payload, ...entered } : { value: payload, ...entered };
        this.appendAudit(opts.auditTopic, issueNumber, opts.auditActor ?? "archangel", body, now, repo);
      } else {
        this.appendAudit("thread/phase_entered", issueNumber, "archangel", entered, now, repo);
      }
      for (const a of opts.extraAudits ?? []) {
        this.appendAudit(a.topic, issueNumber, a.actor, a.payload, now, repo);
      }
      // One durable row per escalation, carrying its code, so failure clustering has history after the Thread resumes.
      if (validated.kind === "needs_you") {
        this.appendAudit("escalation/raised", issueNumber, "archangel", { code: validated.code }, now, repo);
      }

      return this.getThread(issueNumber, repo);
    });

    return tx.immediate();
  }

  /**
   * Startup crash recovery (Opus L1/L2 fix):
   * ONLY recovers threads stuck in `working` phase to their saved `resumeTo`.
   * NEVER touches `needs_you`, `shadow_ready`, `owner_driving`, or `done`!
   */
  sweepStaleWorkingRuns(now = Date.now(), repo = this.repo): number[] {
    const workingRows = this.listThreads(["working"], repo);
    const recovered: number[] = [];

    const tx = this.db.transaction(() => {
      for (const t of workingRows) {
        if (t.phase.kind !== "working") continue;
        this.db
          .prepare(
            `UPDATE attempts SET status = 'failed', error_message = 'stale working run swept on startup', error_category = 'other', finished_at = ?
             WHERE repo = ? AND issue_number = ? AND status = 'running'`,
          )
          .run(now, repo, t.issueNumber);

        const stepped = stepPhase(
          t.phase,
          t.mode,
          { t: "restart_recovered", now },
          { issueNumber: t.issueNumber, title: t.title, needsYouLabel: "" },
        );
        if (!stepped.ok) continue;

        const updated = this.transition(t.issueNumber, t.version, stepped.next, {
          auditTopic: "thread/stale_swept",
          auditPayload: { previousAttempt: t.phase.attempt, next: stepped.next.kind },
          now,
          repo,
        });
        if (updated) recovered.push(t.issueNumber);
      }
      // Also release any leaked in-flight budget reservations from crashed runs on startup.
      this.db
        .prepare(`UPDATE daily_spend SET reserved_usd = 0, updated_at = ? WHERE reserved_usd > 0`)
        .run(now);
    });
    tx.immediate();
    return recovered;
  }


  /** Deliverable rows: not dead-lettered and past their backoff. Least-failed first, so rows that keep failing cannot starve newer effects out of the batch limit. */
  listDueOutbox(now = Date.now(), repo = this.repo, limit = 50): OutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox WHERE repo = ? AND state != 'dead_letter' AND next_attempt_at <= ?
         ORDER BY attempts ASC, id ASC LIMIT ?`,
      )
      .all(repo, now, limit) as Record<string, unknown>[];
    return rows.map(outboxRecord);
  }

  /** Outbox effects that have failed at least `minAttempts` times, dead-lettered ones included (stuck: never delivered). */
  listStuckOutbox(minAttempts = 3): OutboxRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM outbox WHERE attempts >= ? OR state = 'dead_letter' ORDER BY id ASC`)
      .all(minAttempts) as Record<string, unknown>[];
    return rows.map(outboxRecord);
  }

  /** The autonomy cap was reached and the owner has not been heard from since (an owner audit row clears it). */
  autonomyCapHitSinceOwner(repo = this.repo): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM audit_log WHERE repo = ? AND topic = 'autonomy/cap_reached'
             AND id > COALESCE((SELECT MAX(id) FROM audit_log WHERE repo = ? AND actor = 'owner'), 0) LIMIT 1`,
        )
        .get(repo, repo),
    );
  }

  /** Dead-lettered rows, kept so the owner can see what never went out. */
  listDeadOutbox(repo = this.repo): OutboxRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM outbox WHERE repo = ? AND state = 'dead_letter' ORDER BY id ASC`)
      .all(repo) as Record<string, unknown>[];
    return rows.map(outboxRecord);
  }

  /** True while an `add_label` for this label on this issue is still queued (not delivered, not dead-lettered). */
  hasPendingLabelAdd(issueNumber: number, label: string, repo = this.repo): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM outbox WHERE repo = ? AND state != 'dead_letter'
             AND json_extract(effect_json, '$.kind') = 'add_label'
             AND json_extract(effect_json, '$.issueNumber') = ?
             AND json_extract(effect_json, '$.label') = ? LIMIT 1`,
        )
        .get(repo, issueNumber, label) !== null
    );
  }

  completeOutbox(id: number): void {
    this.db.prepare(`DELETE FROM outbox WHERE id = ?`).run(id);
  }

  /** A failed delivery: exponential backoff, then dead-letter after OUTBOX_MAX_ATTEMPTS. */
  failOutbox(id: number, error: string, now = Date.now()): void {
    const row = this.db.prepare(`SELECT attempts FROM outbox WHERE id = ?`).get(id) as { attempts: number } | undefined;
    if (!row) return;
    const attempts = row.attempts + 1;
    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      this.db
        .prepare(`UPDATE outbox SET attempts = ?, state = 'dead_letter', last_error = ? WHERE id = ?`)
        .run(attempts, error, id);
      this.appendAudit("outbox/dead_letter", null, "archangel", { id, attempts, error });
      return;
    }
    const delay = Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** (attempts - 1), OUTBOX_BACKOFF_MAX_MS);
    this.db
      .prepare(`UPDATE outbox SET attempts = ?, state = 'retrying', next_attempt_at = ?, last_error = ? WHERE id = ?`)
      .run(attempts, now + delay, error, id);
  }

  /** A row that cannot be delivered at all (unknown or malformed effect): straight to dead letter, never dropped. */
  deadLetterOutbox(id: number, error: string): void {
    this.db.prepare(`UPDATE outbox SET state = 'dead_letter', last_error = ? WHERE id = ?`).run(error, id);
    this.appendAudit("outbox/dead_letter", null, "archangel", { id, error });
  }

  /** Commands are transient (a CLI waits seconds for the daemon): an old-shape table is dropped, not migrated. */
  private dropLegacyDaemonCommands(): void {
    const cols = (this.db.prepare("PRAGMA table_info(daemon_commands)").all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.includes("status")) this.db.exec("DROP TABLE daemon_commands");
  }


  enqueueCommand(issueNumber: number, kind: "handoff", now = Date.now(), repo = this.repo): number {
    const info = this.db
      .prepare(`INSERT INTO daemon_commands (repo, issue_number, kind, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(repo, issueNumber, kind, JSON.stringify({ kind: "pending" }), now, now);
    return Number(info.lastInsertRowid);
  }

  listPendingCommands(repo = this.repo): DaemonCommandRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM daemon_commands WHERE repo = ? AND state = 'pending' ORDER BY id ASC`)
      .all(repo) as Record<string, unknown>[];
    return rows.map(mapCommand);
  }

  getCommand(id: number): DaemonCommandRecord | null {
    const row = this.db.prepare(`SELECT * FROM daemon_commands WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? mapCommand(row) : null;
  }

  /**
   * The only way a command changes state: read, `stepCommand`, compare-and-set on `version`. Returns false (and audits an illegal
   * move) when the transition is not allowed or lost a race, so a CLI timeout and the daemon cannot both win.
   */
  stepCommandState(id: number, ev: CommandEvent, now = Date.now()): boolean {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.prepare(`SELECT repo, issue_number, state_json, version FROM daemon_commands WHERE id = ?`).get(id) as
        | { repo: string; issue_number: number; state_json: string; version: number }
        | undefined;
      if (!row) return false;
      const state = CommandStateSchema.parse(JSON.parse(row.state_json));
      const step = stepCommand(state, ev);
      if (!step.ok) {
        this.appendAudit("command/illegal_transition", row.issue_number, "archangel", { id, from: state.kind, event: ev.t }, now, row.repo);
        return false;
      }
      return (
        this.db
          .prepare(`UPDATE daemon_commands SET state_json = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`)
          .run(JSON.stringify(step.next), now, id, row.version).changes === 1
      );
    });
    return tx.immediate();
  }

  /** The daemon takes a pending command. False when the CLI already cancelled it (or another claim won). */
  claimCommand(id: number, now = Date.now()): boolean {
    return this.stepCommandState(id, { t: "claim", at: now }, now);
  }

  completeCommand(id: number, result: unknown, now = Date.now()): boolean {
    return this.stepCommandState(id, { t: "complete", result }, now);
  }

  failCommand(id: number, errorMessage: string, now = Date.now()): boolean {
    return this.stepCommandState(id, { t: "fail", error: errorMessage }, now);
  }

  /** The CLI gives up. Only a command the daemon has not claimed can be cancelled: false means the daemon is already working on it. */
  cancelCommand(id: number, reason: string, now = Date.now()): boolean {
    return this.stepCommandState(id, { t: "cancel", reason }, now);
  }


  startAttempt(issueNumber: number, kind: AttemptKind, now = Date.now(), repo = this.repo): AttemptRecord {
    const info = this.db
      .prepare(
        `INSERT INTO attempts (repo, issue_number, kind, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(repo, issueNumber, kind, now);
    const id = Number(info.lastInsertRowid);
    this.appendAudit("attempt/started", issueNumber, "archangel", { attemptId: id, kind }, now, repo);
    return this.getAttempt(id)!;
  }

  /** Replay provenance for an Attempt: who ran it, with which prompt template, under which workflow file. */
  recordAttemptProvenance(
    attemptId: number,
    p: { provider?: string | null; model?: string | null; accountId?: string | null; compute?: string | null; promptSha256?: string | null; workflowSha256?: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE attempts SET provider = COALESCE(?, provider), model = COALESCE(?, model), account_id = COALESCE(?, account_id), compute = COALESCE(?, compute),
           prompt_sha256 = COALESCE(?, prompt_sha256), workflow_sha256 = COALESCE(?, workflow_sha256) WHERE id = ?`,
      )
      .run(p.provider ?? null, p.model ?? null, p.accountId ?? null, p.compute ?? null, p.promptSha256 ?? null, p.workflowSha256 ?? null, attemptId);
  }

  /** What the Attempt's agent runs cost in wall time and memory (peak RSS in KB, null when never sampled). */
  recordAttemptMeasure(attemptId: number, m: { durationMs: number; peakRssKb: number | null }): void {
    this.db.prepare(`UPDATE attempts SET duration_ms = ?, peak_rss_kb = ? WHERE id = ?`).run(Math.round(m.durationMs), m.peakRssKb, attemptId);
  }

  /** Replay capture for a revise or rebase Attempt: the head it started from and its sanitized input (null when not capturable). */
  recordAttemptInput(attemptId: number, fromSha: string, inputJson: string | null): void {
    this.db.prepare(`UPDATE attempts SET from_sha = ?, input_json = ? WHERE id = ?`).run(fromSha, inputJson, attemptId);
  }

  /** Revise and rebase Attempts with a captured input, oldest first. */
  listAttemptInputs(repo = this.repo): Array<{ attemptId: number; issueNumber: number; kind: "revise" | "rebase"; fromSha: string; input: AttemptInput }> {
    const rows = this.db
      .prepare(`SELECT id, issue_number, kind, from_sha, input_json FROM attempts WHERE repo = ? AND kind IN ('revise', 'rebase') AND from_sha IS NOT NULL AND input_json IS NOT NULL ORDER BY id`)
      .all(repo) as Array<Record<string, unknown>>;
    return rows.flatMap((r) => {
      const input = parseAttemptInput(String(r.input_json));
      return input && input.kind === r.kind ? [{ attemptId: Number(r.id), issueNumber: Number(r.issue_number), kind: input.kind, fromSha: String(r.from_sha), input }] : [];
    });
  }

  finishAttempt(
    attemptId: number,
    result: {
      headSha?: string | null;
      costUsd?: number;
      reservedUsd?: number;
      transcriptPath?: string | null;
    } & (
      | { status: "succeeded" }
      // An unsuccessful Attempt always says why, as a closed category, alongside the human message.
      | { status: "failed" | "aborted"; errorCategory: AttemptErrorCategory; errorMessage: string }
    ),
    now = Date.now(),
  ): AttemptRecord {
    const cost = Math.max(0, result.costUsd ?? 0);
    // An Attempt is finished once. A second finish (a late error handler after the first outcome was recorded) must not
    // rewrite the outcome or settle the budget twice.
    const done = this.db
      .prepare(
        `UPDATE attempts
         SET status = ?, head_sha = ?, cost_usd = ?, transcript_path = ?, error_message = ?, error_category = ?, finished_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        result.status,
        result.headSha ?? null,
        cost,
        result.transcriptPath ?? null,
        result.status === "succeeded" ? null : result.errorMessage,
        result.status === "succeeded" ? null : result.errorCategory,
        now,
        attemptId,
      );
    if (done.changes === 0) return this.getAttempt(attemptId)!;
    if (result.reservedUsd !== undefined) {
      this.settleBudget(result.reservedUsd, cost, now);
    } else if (cost > 0) {
      this.addSpend(cost, now);
    }
    const attempt = this.getAttempt(attemptId)!;
    const provider = (attempt.provider ?? "none") as TelemetryTags<"attempt_ms">["provider"];
    emit("attempt_ms", attempt.durationMs ?? now - attempt.startedAt, { kind: attempt.kind, provider, outcome: result.status }, attempt.repo);
    if (attempt.peakRssKb !== null) emit("attempt_rss_kb", attempt.peakRssKb, { kind: attempt.kind, provider }, attempt.repo);
    this.appendAudit(
      "attempt/finished",
      attempt.issueNumber,
      "archangel",
      {
        attemptId,
        status: result.status,
        headSha: result.headSha ?? null,
        costUsd: cost,
        error: result.status === "succeeded" ? null : result.errorMessage,
        errorCategory: result.status === "succeeded" ? null : result.errorCategory,
      },
      now,
      attempt.repo,
    );
    return attempt;
  }

  getAttempt(id: number): AttemptRecord | null {
    const row = this.db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapAttempt(row) : null;
  }

  /** Every Attempt for one Thread, oldest first (the dashboard's Thread timeline). */
  listAttemptsFor(issueNumber: number, repo = this.repo): AttemptRecord[] {
    return (this.db.prepare(`SELECT * FROM attempts WHERE repo = ? AND issue_number = ? ORDER BY id ASC`).all(repo, issueNumber) as Record<string, unknown>[]).map(mapAttempt);
  }


  recordPushedSha(
    sha: string,
    issueNumber: number,
    origin: "broker" | "owner_resume",
    now = Date.now(),
    repo = this.repo,
  ): void {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO pushed_shas (repo, sha, issue_number, origin, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(repo, sha, issueNumber, origin, now);
    if (res.changes > 0) {
      this.appendAudit("broker/sha_recorded", issueNumber, origin, { sha }, now, repo);
    }
  }

  isKnownSha(
    issueNumber: number,
    sha: string,
    repo = this.repo,
  ): { known: boolean; origin: string | null } {
    const row = this.db
      .prepare(`SELECT origin FROM pushed_shas WHERE repo = ? AND sha = ? AND issue_number = ?`)
      .get(repo, sha, issueNumber) as { origin: string } | undefined;
    return row ? { known: true, origin: row.origin } : { known: false, origin: null };
  }


  recordReview(input: {
    issueNumber: number;
    headSha: string;
    vendor: ReviewerVendor;
    verdict: ReviewVerdict;
    findings: ReviewFinding[];
    costUsd: number;
    provider?: string | null;
    model?: string | null;
    accountId?: string | null;
    promptSha256?: string | null;
    rubricSha256?: string | null;
    workflowSha256?: string | null;
    now?: number;
    repo?: string;
  }): ReviewRecord {
    const repo = input.repo ?? this.repo;
    const now = input.now ?? Date.now();
    const cost = Math.max(0, input.costUsd);
    this.db
      .prepare(
        `INSERT INTO reviews (repo, issue_number, head_sha, vendor, verdict, findings_json, cost_usd, created_at,
                              provider, model, account_id, prompt_sha256, rubric_sha256, workflow_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, issue_number, head_sha, vendor) DO UPDATE SET
           verdict = excluded.verdict,
           findings_json = excluded.findings_json,
           cost_usd = excluded.cost_usd,
           created_at = excluded.created_at,
           provider = excluded.provider,
           model = excluded.model,
           account_id = excluded.account_id,
           prompt_sha256 = excluded.prompt_sha256,
           rubric_sha256 = excluded.rubric_sha256,
           workflow_sha256 = excluded.workflow_sha256`,
      )
      .run(
        repo,
        input.issueNumber,
        input.headSha,
        input.vendor,
        input.verdict,
        JSON.stringify(input.findings),
        cost,
        now,
        input.provider ?? null,
        input.model ?? null,
        input.accountId ?? null,
        input.promptSha256 ?? null,
        input.rubricSha256 ?? null,
        input.workflowSha256 ?? null,
      );
    if (cost > 0) {
      this.addSpend(cost, now);
    }
    this.appendAudit(
      "review/recorded",
      input.issueNumber,
      input.vendor,
      {
        headSha: input.headSha,
        verdict: input.verdict,
        findingsCount: input.findings.length,
        costUsd: cost,
      },
      now,
      repo,
    );
    return this.getReviewsForSha(input.issueNumber, input.headSha, repo).find(
      (r) => r.vendor === input.vendor,
    )!;
  }

  getReviewsForSha(issueNumber: number, headSha: string, repo = this.repo): ReviewRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reviews WHERE repo = ? AND issue_number = ? AND head_sha = ? ORDER BY vendor ASC`,
      )
      .all(repo, issueNumber, headSha) as Record<string, unknown>[];
    return rows.map(mapReview);
  }

  listReviewsFor(issueNumber: number, repo = this.repo): ReviewRecord[] {
    return (this.db.prepare(`SELECT * FROM reviews WHERE repo = ? AND issue_number = ? ORDER BY id ASC`).all(repo, issueNumber) as Record<string, unknown>[]).map(mapReview);
  }

  listMergesFor(issueNumber: number, repo = this.repo): MergeRecord[] {
    return (this.db.prepare(`SELECT * FROM merges WHERE repo = ? AND issue_number = ? ORDER BY id ASC`).all(repo, issueNumber) as Record<string, unknown>[]).map(mapMerge);
  }


  recordMerge(input: {
    issueNumber: number;
    prNumber: number;
    headSha: string;
    squashSha?: string | null;
    shadowOnly: boolean;
    /** Non-Gate required checks to watch on main after this merge. */
    mainRequired?: string[];
    now?: number;
    repo?: string;
  }): MergeRecord {
    const repo = input.repo ?? this.repo;
    const now = input.now ?? Date.now();
    if (!input.shadowOnly && (input.mainRequired ?? []).length === 0) {
      throw new Error("recordMerge: an autonomous merge must record mainRequired (the non-Gate checks to watch on main)");
    }
    const dayKey = formatDayKey(now, this.timeZone);
    const initialWatch: MainWatch = input.shadowOnly
      ? { kind: "green" }
      : { kind: "watching", since: now };

    if (input.shadowOnly) {
      const existing = this.db
        .prepare(
          `SELECT * FROM merges WHERE repo = ? AND issue_number = ? AND head_sha = ? AND shadow_only = 1`,
        )
        .get(repo, input.issueNumber, input.headSha) as Record<string, unknown> | undefined;
      if (existing) {
        return mapMerge(existing);
      }
    }

    const info = this.db
      .prepare(
        `INSERT INTO merges (repo, issue_number, pr_number, head_sha, squash_sha, shadow_only, day_key, main_watch_json, main_required_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo,
        input.issueNumber,
        input.prNumber,
        input.headSha,
        input.squashSha ?? null,
        input.shadowOnly ? 1 : 0,
        dayKey,
        JSON.stringify(initialWatch),
        JSON.stringify(input.mainRequired ?? []),
        now,
      );
    this.appendAudit(
      input.shadowOnly ? "lander/shadow_ready" : "lander/merged",
      input.issueNumber,
      "lander",
      {
        prNumber: input.prNumber,
        headSha: input.headSha,
        squashSha: input.squashSha ?? null,
      },
      now,
      repo,
    );
    return this.getMerge(Number(info.lastInsertRowid))!;
  }

  /**
   * What replay needs per Thread: the final outcome, the heads that merged, and heads whose Attempt failed with a
   * recorded error. Read-only; the SHAs themselves are kept alive by the Broker's eval refs.
   */
  listReplaySeeds(
    sinceMs = 0,
    repo = this.repo,
  ): Array<{
    issueNumber: number;
    branchName: string;
    phase: Phase;
    updatedAt: number;
    merges: Array<{ headSha: string; shadowOnly: boolean; disagreed: boolean; mainWatch: string }>;
    failedAttempts: Array<{ headSha: string; errorMessage: string; errorCategory: string | null }>;
    title: string;
    /** The issue text kept at intake, or null for Threads from before it was kept. */
    issueBody: string | null;
    /** The most recent head any Attempt produced (the head an owner-closed Thread ended with). */
    lastHead: string | null;
  }> {
    const heads = this.db
      .prepare(`SELECT issue_number, head_sha FROM attempts WHERE repo = ? AND head_sha IS NOT NULL ORDER BY id`)
      .all(repo) as Array<Record<string, unknown>>;
    const merges = this.db
      .prepare(`SELECT issue_number, head_sha, shadow_only, disagreed, main_watch_json FROM merges WHERE repo = ? ORDER BY id`)
      .all(repo) as Array<Record<string, unknown>>;
    const failed = this.db
      .prepare(
        `SELECT issue_number, head_sha, error_message, error_category FROM attempts
         WHERE repo = ? AND status = 'failed' AND head_sha IS NOT NULL AND error_message IS NOT NULL ORDER BY id`,
      )
      .all(repo) as Array<Record<string, unknown>>;
    const bodies = new Map(
      (this.db.prepare(`SELECT issue_number, issue_body FROM threads WHERE repo = ?`).all(repo) as Array<{ issue_number: number; issue_body: string | null }>).map((r) => [Number(r.issue_number), r.issue_body]),
    );
    return this.listThreads(undefined, repo)
      .filter((t) => t.updatedAt >= sinceMs)
      .map((t) => ({
        issueNumber: t.issueNumber,
        title: t.title,
        issueBody: bodies.get(t.issueNumber) ?? null,
        branchName: t.branchName,
        phase: t.phase,
        updatedAt: t.updatedAt,
        merges: merges
          .filter((m) => Number(m.issue_number) === t.issueNumber)
          .map((m) => ({
            headSha: String(m.head_sha),
            shadowOnly: Number(m.shadow_only) === 1,
            disagreed: Number(m.disagreed) === 1,
            mainWatch: String((JSON.parse(String(m.main_watch_json)) as { kind?: string }).kind ?? "unknown"),
          })),
        failedAttempts: failed
          .filter((a) => Number(a.issue_number) === t.issueNumber)
          .map((a) => ({ headSha: String(a.head_sha), errorMessage: String(a.error_message), errorCategory: a.error_category === null ? null : String(a.error_category) })),
        lastHead: heads.filter((h) => Number(h.issue_number) === t.issueNumber).map((h) => String(h.head_sha)).at(-1) ?? null,
      }));
  }

  /** Every commit a Thread's history depends on (reviewed heads, Attempt heads, merged heads), for eval-ref pinning. */
  listEvalShas(repo = this.repo): Array<{ issueNumber: number; sha: string }> {
    const rows = this.db
      .prepare(
        `SELECT issue_number, head_sha AS sha FROM reviews WHERE repo = ?
         UNION SELECT issue_number, head_sha FROM attempts WHERE repo = ? AND head_sha IS NOT NULL
         UNION SELECT issue_number, head_sha FROM merges WHERE repo = ?
         ORDER BY issue_number, sha`,
      )
      .all(repo, repo, repo) as Array<{ issue_number: number; sha: string }>;
    return rows.map((r) => ({ issueNumber: Number(r.issue_number), sha: String(r.sha) }));
  }

  getMerge(id: number): MergeRecord | null {
    const row = this.db.prepare(`SELECT * FROM merges WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapMerge(row) : null;
  }

  getAutoMergeCountToday(now = Date.now(), repo: string | null = this.repo): number {
    const dayKey = formatDayKey(now, this.timeZone);
    if (repo === null) {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM merges WHERE day_key = ? AND shadow_only = 0`)
        .get(dayKey) as { cnt: number };
      return row.cnt;
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM merges WHERE repo = ? AND day_key = ? AND shadow_only = 0`)
      .get(repo, dayKey) as { cnt: number };
    return row.cnt;
  }

  listPendingPostMergeChecks(repo = this.repo): MergeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM merges
         WHERE repo = ? AND shadow_only = 0 AND squash_sha IS NOT NULL
           AND json_extract(main_watch_json, '$.kind') IN ('watching', 'rerun_requested')
         ORDER BY created_at ASC`,
      )
      .all(repo) as Record<string, unknown>[];
    return rows.map(mapMerge);
  }

  updateMergeMainWatch(mergeId: number, watch: MainWatch): void {
    const validated = MainWatchSchema.parse(watch);
    this.db
      .prepare(`UPDATE merges SET main_watch_json = ? WHERE id = ?`)
      .run(JSON.stringify(validated), mergeId);
  }

  /**
   * Synchronizes owner disagreement idempotently (no duplicate audit rows on unchanged ticks).
   * Applies to every merge row of the Thread, shadow or autonomous. Returns how many merge rows the Thread has
   * (0 means there is nothing to mark).
   */
  markDisagree(issueNumber: number, disagreed = true, repo = this.repo): number {
    const flag = disagreed ? 1 : 0;
    const res = this.db
      .prepare(`UPDATE merges SET disagreed = ? WHERE repo = ? AND issue_number = ? AND disagreed != ?`)
      .run(flag, repo, issueNumber, flag);
    if (res.changes > 0) {
      this.appendAudit("shadow/disagree", issueNumber, "owner", { disagreed }, Date.now(), repo);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM merges WHERE repo = ? AND issue_number = ?`)
      .get(repo, issueNumber) as { cnt: number };
    return row.cnt;
  }

  getShadowStats(repo: string | null = null, sinceMs = 0): {
    total: number;
    agreed: number;
    disagreed: number;
    agreementRate: number;
  } {
    const row = (
      repo === null && sinceMs <= 0
        ? this.db
            .prepare(
              `SELECT COUNT(*) AS total, SUM(CASE WHEN disagreed = 1 THEN 1 ELSE 0 END) AS disagreed
               FROM merges WHERE shadow_only = 1`,
            )
            .get()
        : repo === null
          ? this.db
              .prepare(
                `SELECT COUNT(*) AS total, SUM(CASE WHEN disagreed = 1 THEN 1 ELSE 0 END) AS disagreed
                 FROM merges WHERE shadow_only = 1 AND created_at >= ?`,
              )
              .get(sinceMs)
          : sinceMs <= 0
        ? this.db
            .prepare(
              `SELECT COUNT(*) AS total, SUM(CASE WHEN disagreed = 1 THEN 1 ELSE 0 END) AS disagreed
               FROM merges WHERE repo = ? AND shadow_only = 1`,
            )
            .get(repo)
        : this.db
            .prepare(
              `SELECT COUNT(*) AS total, SUM(CASE WHEN disagreed = 1 THEN 1 ELSE 0 END) AS disagreed
               FROM merges WHERE repo = ? AND shadow_only = 1 AND created_at >= ?`,
            )
            .get(repo, sinceMs)
    ) as { total: number; disagreed: number | null };
    const total = row.total;
    const disagreed = row.disagreed ?? 0;
    const agreed = total - disagreed;
    return {
      total,
      agreed,
      disagreed,
      agreementRate: total === 0 ? 1 : agreed / total,
    };
  }


  getSpendBreakdown(now = Date.now()): { spentUsd: number; reservedUsd: number; committedUsd: number } {
    const dayKey = formatDayKey(now, this.timeZone);
    const row = this.db
      .prepare(`SELECT usd, reserved_usd FROM daily_spend WHERE day_key = ?`)
      .get(dayKey) as { usd: number; reserved_usd: number } | undefined;
    const spentUsd = row?.usd ?? 0;
    const reservedUsd = row?.reserved_usd ?? 0;
    return { spentUsd, reservedUsd, committedUsd: spentUsd + reservedUsd };
  }

  /** Metered USD spent on each of the last `days` local days, oldest first (read-only; days with no row are 0). */
  dailySpend(days: number, now: number): Array<{ day: string; usd: number }> {
    const q = this.db.prepare(`SELECT usd FROM daily_spend WHERE day_key = ?`);
    return Array.from({ length: days }, (_, i) => {
      const day = formatDayKey(now - (days - 1 - i) * 86_400_000, this.timeZone);
      return { day, usd: (q.get(day) as { usd: number } | undefined)?.usd ?? 0 };
    });
  }

  getSpendToday(now = Date.now()): number {
    return this.getSpendBreakdown(now).spentUsd;
  }

  /**
   * Atomically reserves up to `desiredUsd` from the remaining daily budget.
   * Returns the reserved amount (> 0) or `null` if insufficient budget remains (< `minRequiredUsd`).
   */
  reserveBudget(
    maxDailyUsd: number,
    desiredUsd: number,
    minRequiredUsd = 0.01,
    now = Date.now(),
  ): number | null {
    const dayKey = formatDayKey(now, this.timeZone);
    const tx = this.db.transaction((): number | null => {
      const { committedUsd } = this.getSpendBreakdown(now);
      const remaining = maxDailyUsd - committedUsd;
      if (remaining < minRequiredUsd) {
        return null;
      }
      const grant = Math.min(desiredUsd, remaining);
      this.db
        .prepare(
          `INSERT INTO daily_spend (day_key, usd, reserved_usd, updated_at) VALUES (?, 0, ?, ?)
           ON CONFLICT(day_key) DO UPDATE SET reserved_usd = reserved_usd + excluded.reserved_usd, updated_at = excluded.updated_at`,
        )
        .run(dayKey, grant, now);
      return grant;
    });
    return tx();
  }

  settleBudget(reservedUsd: number, actualUsd: number, now = Date.now()): void {
    const dayKey = formatDayKey(now, this.timeZone);
    const actual = Math.max(0, actualUsd);
    const reserved = Math.max(0, reservedUsd);
    this.db
      .prepare(
        `INSERT INTO daily_spend (day_key, usd, reserved_usd, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(day_key) DO UPDATE SET
           usd = usd + excluded.usd,
           reserved_usd = MAX(0, reserved_usd - ?),
           updated_at = excluded.updated_at`,
      )
      .run(dayKey, actual, now, reserved);
  }

  addSpend(usd: number, now = Date.now()): number {
    const dayKey = formatDayKey(now, this.timeZone);
    this.db
      .prepare(
        `INSERT INTO daily_spend (day_key, usd, reserved_usd, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(day_key) DO UPDATE SET usd = usd + excluded.usd, updated_at = excluded.updated_at`,
      )
      .run(dayKey, usd, now);
    return this.getSpendToday(now);
  }


  setCircuitBreaker(tripped: boolean, reason?: string, now = Date.now(), repo = this.repo): void {
    const current = this.getCircuitBreaker(repo);
    if (current.tripped === tripped && current.reason === (reason ?? "")) {
      return;
    }
    this.setSystemState(`circuit_breaker_tripped:${repo}`, tripped ? "1" : "0", now);
    this.setSystemState(`circuit_breaker_reason:${repo}`, reason ?? "", now);
    this.appendAudit(
      "system/circuit_breaker",
      null,
      "archangel",
      { tripped, reason: reason ?? "" },
      now,
      repo,
    );
  }

  getCircuitBreaker(repo = this.repo): { tripped: boolean; reason: string } {
    return {
      tripped: this.getSystemState(`circuit_breaker_tripped:${repo}`) === "1",
      reason: this.getSystemState(`circuit_breaker_reason:${repo}`) ?? "",
    };
  }

  setSystemState(key: string, value: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now);
  }

  getSystemState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM system_state WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }


  appendAudit(
    topic: string,
    issueNumber: number | null,
    actor: string,
    payload: unknown,
    now = Date.now(),
    repo: string | null = this.repo,
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (ts, repo, topic, issue_number, actor, payload_json) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(now, repo, topic, issueNumber, actor, JSON.stringify(payload));
  }

  /** True once a `/archangel` comment (by GitHub comment id) has been processed or deliberately ignored. */
  hasHandledOwnerCommand(commentId: number, repo = this.repo): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM audit_log WHERE repo = ? AND topic LIKE 'owner_command/%'
             AND json_extract(payload_json, '$.commentId') = ? LIMIT 1`,
        )
        .get(repo, commentId),
    );
  }

  /** Durable per-comment record: the dedupe key survives restarts. Owner commands count as owner actions. */
  recordOwnerCommand(
    commentId: number,
    issueNumber: number,
    outcome: "retry" | "close" | "handoff_requested" | "unknown" | "ignored",
    actor: string,
    now = Date.now(),
  ): void {
    this.appendAudit(`owner_command/${outcome}`, issueNumber, actor, { commentId }, now);
  }

  /**
   * Autonomous steps (Attempt starts and autonomous merges) since the owner was last heard from,
   * i.e. since the latest audit row whose actor is 'owner'.
   */
  /**
   * What the autonomous steps since the owner was last heard from were spent on, per Thread (the same rows
   * `autonomousStepsSinceOwner` counts), plus the Threads waiting in needs_you. Counts and issue numbers only.
   */
  autonomousStepBreakdown(repo = this.repo): {
    threads: Array<{ issueNumber: number; implement: number; revise: number; rebase: number; merged: number; total: number }>;
    needsYou: number[];
  } {
    const rows = this.db
      .prepare(
        `SELECT issue_number, topic, json_extract(payload_json, '$.kind') AS kind FROM audit_log
         WHERE repo = ? AND topic IN ('attempt/started', 'thread/merged')
           AND id > COALESCE((SELECT MAX(id) FROM audit_log WHERE repo = ? AND actor = 'owner'), 0)`,
      )
      .all(repo, repo) as Array<{ issue_number: number | null; topic: string; kind: string | null }>;
    const by = new Map<number, { issueNumber: number; implement: number; revise: number; rebase: number; merged: number; total: number }>();
    for (const r of rows) {
      if (r.issue_number === null) continue;
      const t = by.get(r.issue_number) ?? { issueNumber: r.issue_number, implement: 0, revise: 0, rebase: 0, merged: 0, total: 0 };
      if (r.topic === "thread/merged") t.merged++;
      else if (r.kind === "revise") t.revise++;
      else if (r.kind === "rebase") t.rebase++;
      else t.implement++;
      t.total++;
      by.set(r.issue_number, t);
    }
    return {
      threads: [...by.values()].sort((a, b) => b.total - a.total || a.issueNumber - b.issueNumber),
      needsYou: this.listThreads(["needs_you"], repo).map((t) => t.issueNumber),
    };
  }

  /** Timestamp of the latest owner audit row for the repo: the row that resets `autonomousStepsSinceOwner`. */
  ownerLastHeardAt(repo = this.repo): number | null {
    const row = this.db.prepare(`SELECT ts FROM audit_log WHERE repo = ? AND actor = 'owner' ORDER BY id DESC LIMIT 1`).get(repo) as { ts: number } | undefined;
    return row?.ts ?? null;
  }

  autonomousStepsSinceOwner(repo = this.repo): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM audit_log
         WHERE repo = ? AND topic IN ('attempt/started', 'thread/merged')
           AND id > COALESCE((SELECT MAX(id) FROM audit_log WHERE repo = ? AND actor = 'owner'), 0)`,
      )
      .get(repo, repo) as { n: number };
    return row.n;
  }

  /**
   * Has this repo's audit log a row matching all of these? The "notify once" markers use it: it is always scoped to this repo (one repo's
   * marker must never silence another's) and unlimited (an old marker must not age out of a LIMIT and let the alert fire again).
   */
  hasAudit(q: { topic: string; actor?: string; issueNumber?: number; sinceMs?: number; payload?: { key: "category" | "trustHash"; value: string } }, repo = this.repo): boolean {
    const where = [`repo = ?`, `topic = ?`];
    const params: SQLQueryBindings[] = [repo, q.topic];
    if (q.actor !== undefined) { where.push(`actor = ?`); params.push(q.actor); }
    if (q.issueNumber !== undefined) { where.push(`issue_number = ?`); params.push(q.issueNumber); }
    if (q.sinceMs !== undefined) { where.push(`ts >= ?`); params.push(q.sinceMs); }
    if (q.payload) { where.push(`json_extract(payload_json, '$.${q.payload.key}') = ?`); params.push(q.payload.value); }
    return Boolean(this.db.prepare(`SELECT 1 FROM audit_log WHERE ${where.join(" AND ")} LIMIT 1`).get(...params));
  }

  /** The latest `factory/triage` audit row of a Thread (what machine triage decided), or null when triage never ran. */
  latestTriage(issueNumber: number, repo = this.repo): TriageSummary | null {
    const row = this.listAudit({ repo, topicPrefix: "factory/triage", issueNumber, limit: 1 })[0];
    if (!row) return null;
    const p = JSON.parse(row.payloadJson) as { vendor?: unknown; action?: unknown; cause?: unknown; steps?: unknown; reason?: unknown };
    if (typeof p.vendor !== "string" || (p.action !== "guidance" && p.action !== "escalate") || typeof p.cause !== "string") return null;
    return {
      vendor: p.vendor,
      action: p.action,
      cause: p.cause,
      steps: Array.isArray(p.steps) ? p.steps.filter((s): s is string => typeof s === "string") : [],
      reason: typeof p.reason === "string" ? p.reason : null,
    };
  }

  /**
   * One per-Thread recommendation attempt for a needs_you entry (`factory/recommendation` audit row). `headline`/`reason` are null when the
   * run produced nothing usable: the row still stands, so the same entry is never asked twice. Text is model-written and vetted by the caller.
   */
  recordThreadRecommendation(issueNumber: number, p: { code: string; headSha: string | null; vendor: string; headline: string | null; reason: string | null }, now = Date.now()): void {
    this.appendAudit("factory/recommendation", issueNumber, "factory", p, now);
  }

  /** The latest attempt row for this Thread when it is for the Thread's current needs_you entry (same code and head), else null. `text` is null when the attempt produced nothing. */
  threadRecommendationFor(thread: ThreadRecord): { text: { headline: string; reason: string } | null } | null {
    if (thread.phase.kind !== "needs_you") return null;
    const row = this.listAudit({ repo: thread.repo, topicPrefix: "factory/recommendation", issueNumber: thread.issueNumber, limit: 1 })[0];
    if (!row) return null;
    const p = JSON.parse(row.payloadJson) as { code?: unknown; headSha?: unknown; headline?: unknown; reason?: unknown };
    if (p.code !== thread.phase.code || (p.headSha ?? null) !== (thread.phase.headSha ?? null)) return null;
    return { text: typeof p.headline === "string" && typeof p.reason === "string" ? { headline: p.headline, reason: p.reason } : null };
  }

  recommendationsInLast24h(now = Date.now(), repo = this.repo): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE repo = ? AND topic = 'factory/recommendation' AND ts > ?").get(repo, now - 86_400_000) as { n: number }
    ).n;
  }

  /** Rows of one audit topic across every repo since `sinceMs` (for limits that are global rather than per repo). */
  countAuditAllRepos(topic: string, sinceMs: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE topic = ? AND ts >= ?").get(topic, sinceMs) as { n: number }).n;
  }

  listAudit(
    opts: { repo?: string; topicPrefix?: string; issueNumber?: number; limit?: number } = {},
  ): AuditLogEntry[] {
    const where: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (opts.repo) {
      where.push(`repo = ?`);
      params.push(opts.repo);
    }
    if (opts.topicPrefix) {
      where.push(`topic LIKE ?`);
      params.push(`${opts.topicPrefix}%`);
    }
    if (opts.issueNumber !== undefined) {
      where.push(`issue_number = ?`);
      params.push(opts.issueNumber);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    params.push(limit);
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      repo: r.repo === null ? null : String(r.repo),
      topic: String(r.topic),
      issueNumber: r.issue_number === null ? null : Number(r.issue_number),
      actor: String(r.actor),
      payloadJson: String(r.payload_json),
    }));
  }

  /** Merges implementer vendor(s) durably onto the thread (survives restarts & revisions — Opus B1). */
  recordImplementerVendors(issueNumber: number, vendors: ReviewerVendor[], now = Date.now()): ReviewerVendor[] {
    if (vendors.length === 0) return this.getThread(issueNumber)?.implementerVendors ?? [];
    const current = this.getThread(issueNumber)?.implementerVendors ?? [];
    const merged = [...new Set<ReviewerVendor>([...current, ...vendors])];
    this.db
      .prepare(
        "UPDATE threads SET implementer_vendors_json = ?, updated_at = ? WHERE repo = ? AND issue_number = ?",
      )
      .run(JSON.stringify(merged), now, this.repo, issueNumber);
    return merged;
  }


  /** Cools one account down after a limit error. The audit row keeps the count and total cooldown time for metrics. */
  setAccountCooldown(accountId: string, durationMs: number, reason: string, now = Date.now()): void {
    const duration = Math.max(1000, durationMs);
    this.db
      .prepare(
        `INSERT INTO account_cooldowns(account_id, until_ts, reason, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET until_ts = excluded.until_ts, reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .run(accountId, now + duration, reason.slice(0, 300), now);
    emit("account_cooldown", 1, { account: accountId });
    this.appendAudit("account/cooldown", null, "archangel", { accountId, durationMs: duration }, now, null);
  }

  getAccountCooldown(accountId: string, now = Date.now()): { untilTs: number; reason: string } | null {
    const row = this.db
      .prepare("SELECT until_ts, reason FROM account_cooldowns WHERE account_id = ? AND until_ts > ?")
      .get(accountId, now) as { until_ts: number; reason: string } | undefined;
    return row ? { untilTs: Number(row.until_ts), reason: String(row.reason) } : null;
  }

  listActiveCooldowns(now = Date.now()): Array<{ account: string; untilTs: number; reason: string }> {
    const rows = this.db
      .prepare("SELECT account_id, until_ts, reason FROM account_cooldowns WHERE until_ts > ? ORDER BY account_id")
      .all(now) as Array<{ account_id: string; until_ts: number; reason: string }>;
    return rows.map((r) => ({ account: String(r.account_id), untilTs: Number(r.until_ts), reason: String(r.reason) }));
  }

  /** Every account's most recent limit error, including ended cooldowns: the last failover away from it. */
  listAccountSwitches(): Array<{ account: string; at: number; reason: string }> {
    const rows = this.db.prepare("SELECT account_id, updated_at, reason FROM account_cooldowns").all() as Array<{ account_id: string; updated_at: number; reason: string }>;
    return rows.map((r) => ({ account: String(r.account_id), at: Number(r.updated_at), reason: String(r.reason) }));
  }

  /** The selector's view of this Ledger: cooldowns, usage counters, and the optional free Codex reading. */
  accountState(accounts: Account[]): AccountLedger {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    return {
      cooldownUntil: (id, now) => this.getAccountCooldown(id, now)?.untilTs ?? null,
      attemptsToday: (id, now) => {
        const today = formatDayKey(now, this.timeZone);
        const rows = this.db
          .prepare(`SELECT started_at FROM attempts WHERE account_id = ? AND started_at >= ?`)
          .all(id, now - 36 * 3600_000) as Array<{ started_at: number }>;
        return rows.filter((r) => formatDayKey(r.started_at, this.timeZone) === today).length;
      },
      lastUsedAt: (id) => {
        const row = this.db
          .prepare(
            `SELECT MAX(t) AS t FROM (SELECT MAX(started_at) AS t FROM attempts WHERE account_id = ?
                                      UNION ALL SELECT MAX(created_at) AS t FROM reviews WHERE account_id = ?)`,
          )
          .get(id, id) as { t: number | null };
        return row.t ?? null;
      },
      usedPercent: (account) => {
        const a = byId.get(account.id) ?? account;
        return a.provider === "codex" ? (readCodexUsage(a.home)?.usedPercent ?? null) : null;
      },
      recordCooldown: (id, durationMs, reason, now) => this.setAccountCooldown(id, durationMs, reason, now),
    };
  }

  /** Records one survived error of a class. Returns how many of this class were seen in the last 24h (including this one). */
  recordHealthFault(category: string, error: string, now = Date.now(), repo = this.repo): number {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare("SELECT recent_json FROM health_faults WHERE repo = ? AND category = ?").get(repo, category) as { recent_json: string } | undefined;
      const prior = row ? (JSON.parse(row.recent_json) as number[]) : [];
      const recent = [...prior.filter((t) => t > now - HEALTH_WINDOW_MS), now];
      this.db
        .prepare(
          `INSERT INTO health_faults (repo, category, first_seen, last_seen, count, last_error, recent_json) VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(repo, category) DO UPDATE SET last_seen = excluded.last_seen, count = count + 1, last_error = excluded.last_error, recent_json = excluded.recent_json`,
        )
        .run(repo, category, now, now, error.slice(0, 500), JSON.stringify(recent));
      return recent.length;
    });
    return tx.immediate();
  }

  /** Health facts seen in the last 24h (all repos, or one), newest first. */
  listHealthFaults(now = Date.now(), repo?: string): HealthFault[] {
    const rows = this.db
      .prepare(`SELECT * FROM health_faults WHERE last_seen > ? ${repo ? "AND repo = ?" : ""} ORDER BY last_seen DESC`)
      .all(...(repo ? [now - HEALTH_WINDOW_MS, repo] : [now - HEALTH_WINDOW_MS])) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      repo: String(r.repo),
      category: String(r.category),
      firstSeen: Number(r.first_seen),
      lastSeen: Number(r.last_seen),
      count: Number(r.count),
      recent24h: (JSON.parse(String(r.recent_json)) as number[]).filter((t) => t > now - HEALTH_WINDOW_MS).length,
      lastError: String(r.last_error),
    }));
  }


  recordScoutProposal(input: {
    issueNumber: number;
    scoutName: string;
    contentSha256: string;
    titleFp: string;
    fileSha256?: string | null;
    autoPromoted?: boolean;
    now?: number;
    repo?: string;
  }): void {
    const repo = input.repo ?? this.repo;
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO scout_proposals (repo, issue_number, scout_name, content_sha256, title_fp, file_sha256, auto_promoted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo,
        input.issueNumber,
        input.scoutName,
        input.contentSha256,
        input.titleFp,
        input.fileSha256 ?? null,
        input.autoPromoted ? 1 : 0,
        now,
      );
    this.appendAudit(
      "scout/proposal_filed",
      input.issueNumber,
      input.scoutName,
      { titleFp: input.titleFp, contentSha256: input.contentSha256.slice(0, 12) },
      now,
      repo,
    );
  }

  getScoutProposal(issueNumber: number, repo = this.repo): ScoutProposalRecord | null {
    // Database errors propagate: callers fail closed (no intake, no filing) rather than treating "could not read" as "no proposal".
    const row = this.db
      .prepare(
        `SELECT repo, issue_number, scout_name, content_sha256, title_fp, file_sha256, auto_promoted, created_at
         FROM scout_proposals WHERE repo = ? AND issue_number = ?`,
      )
      .get(repo, issueNumber) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      repo: String(row.repo),
      issueNumber: Number(row.issue_number),
      scoutName: String(row.scout_name),
      contentSha256: String(row.content_sha256),
      titleFp: String(row.title_fp),
      fileSha256: row.file_sha256 === null || row.file_sha256 === undefined ? null : String(row.file_sha256),
      autoPromoted: Number(row.auto_promoted) === 1,
      createdAt: Number(row.created_at),
    };
  }

  /** Most recent Scout proposals across all repos (read-only; used by the dashboard). */
  listScoutProposals(limit = 25): ScoutProposalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT repo, issue_number, scout_name, content_sha256, title_fp, file_sha256, auto_promoted, created_at
         FROM scout_proposals ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      repo: String(row.repo),
      issueNumber: Number(row.issue_number),
      scoutName: String(row.scout_name),
      contentSha256: String(row.content_sha256),
      titleFp: String(row.title_fp),
      fileSha256: row.file_sha256 === null || row.file_sha256 === undefined ? null : String(row.file_sha256),
      autoPromoted: Number(row.auto_promoted) === 1,
      createdAt: Number(row.created_at),
    }));
  }

  /** Errors propagate: a failed dedupe read must stop filing, not let a duplicate through. */
  hasScoutTitleFingerprint(titleFp: string, repo = this.repo): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM scout_proposals WHERE repo = ? AND title_fp = ? LIMIT 1`).get(repo, titleFp));
  }

  /** Auto-promoted Scout proposals filed in the last 24 hours (host daily cap). */
  countRecentAutoPromotions(now = Date.now(), repo = this.repo): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM scout_proposals WHERE repo = ? AND auto_promoted = 1 AND created_at > ?`)
      .get(repo, now - 24 * 3600_000) as { n: number };
    return Number(row.n);
  }

  /**
   * Auto-promotion trust for one exact version of a Scout file is revoked once any fix it
   * auto-promoted was disagreed with, reverted, or turned main red, or once its last
   * SCOUT_WASTE_STREAK auto-promoted Threads all ended without a merge (wasted autonomy).
   * Editing the Scout file (an owner-merged change under `.agents/`) yields a new hash and a clean slate.
   */
  isScoutAutoPromoteRevoked(scoutName: string, fileSha256: string, repo = this.repo): boolean {
    return this.isScoutAutoPromoteHarmful(scoutName, fileSha256, repo) || this.isScoutAutoPromoteWasted(scoutName, fileSha256, repo);
  }

  /**
   * Waste: the most recent SCOUT_WASTE_STREAK auto-promoted proposals of this exact Scout version all ended without a merge
   * (Needs You, PR closed, or abandoned). A merged one in that window, or any still in flight, means no streak.
   */
  isScoutAutoPromoteWasted(scoutName: string, fileSha256: string, repo = this.repo): boolean {
    const rows = this.db
      .prepare(
        `SELECT t.phase_json AS phase FROM scout_proposals p
         LEFT JOIN threads t ON t.repo = p.repo AND t.issue_number = p.issue_number
         WHERE p.repo = ? AND p.scout_name = ? AND p.file_sha256 = ? AND p.auto_promoted = 1
         ORDER BY p.created_at DESC, p.issue_number DESC LIMIT ?`,
      )
      .all(repo, scoutName, fileSha256, SCOUT_WASTE_STREAK) as Array<{ phase: string | null }>;
    if (rows.length < SCOUT_WASTE_STREAK) return false;
    return rows.every((r) => {
      if (r.phase === null) return false;
      const phase = JSON.parse(r.phase) as { kind: string; outcome?: string };
      return phase.kind === "needs_you" || (phase.kind === "done" && (phase.outcome === "pr_closed" || phase.outcome === "abandoned"));
    });
  }

  /** The owner has been told, once, that this exact Scout version was revoked for waste. */
  scoutWasteNoticeSent(scoutName: string, trustHash: string, repo = this.repo): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM audit_log WHERE repo = ? AND topic = 'scout/auto_promote_revoked' AND actor = ?
             AND json_extract(payload_json, '$.trustHash') = ? LIMIT 1`,
        )
        .get(repo, scoutName, trustHash),
    );
  }

  markScoutWasteNoticeSent(scoutName: string, trustHash: string, now = Date.now(), repo = this.repo): void {
    this.appendAudit("scout/auto_promote_revoked", null, scoutName, { trustHash, reason: "waste" }, now, repo);
  }

  private isScoutAutoPromoteHarmful(scoutName: string, fileSha256: string, repo: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM scout_proposals p
         LEFT JOIN merges m ON m.repo = p.repo AND m.issue_number = p.issue_number
         LEFT JOIN threads t ON t.repo = p.repo AND t.issue_number = p.issue_number
         WHERE p.repo = ? AND p.scout_name = ? AND p.file_sha256 = ? AND p.auto_promoted = 1
           AND (m.disagreed = 1
                OR json_extract(m.main_watch_json, '$.kind') = 'red'
                OR json_extract(t.phase_json, '$.outcome') = 'reverted')
         LIMIT 1`,
      )
      .get(repo, scoutName, fileSha256);
    return Boolean(row);
  }

  insertTelemetry(r: { ts: number; repo: string | null; name: string; value: number; tagsJson: string }): void {
    this.db.prepare(`INSERT INTO telemetry (ts, repo, name, value, tags_json) VALUES (?, ?, ?, ?, ?)`).run(r.ts, r.repo, r.name, r.value, r.tagsJson);
  }

  /** Deletes up to `limit` telemetry rows older than `beforeMs`; call again while it returns `limit`. */
  pruneTelemetry(beforeMs: number, limit: number): number {
    return this.db.prepare(`DELETE FROM telemetry WHERE id IN (SELECT id FROM telemetry WHERE ts < ? LIMIT ?)`).run(beforeMs, limit).changes;
  }

  /** Telemetry rows of one event from `sinceMs` (to `untilMs`, exclusive), optionally for one repo. */
  listTelemetry(name: string, sinceMs: number, untilMs = Number.MAX_SAFE_INTEGER, repo?: string | null): Array<{ ts: number; repo: string | null; value: number; tags: Record<string, string> }> {
    const rows = this.db
      .prepare(`SELECT ts, repo, value, tags_json FROM telemetry WHERE name = ? AND ts >= ? AND ts < ? ${repo === undefined ? "" : repo === null ? "AND repo IS NULL" : "AND repo = ?"} ORDER BY ts`)
      .all(...([name, sinceMs, untilMs, ...(typeof repo === "string" ? [repo] : [])] as Array<string | number>)) as Array<{ ts: number; repo: string | null; value: number; tags_json: string }>;
    return rows.map((r) => ({ ts: r.ts, repo: r.repo, value: r.value, tags: JSON.parse(r.tags_json) as Record<string, string> }));
  }

  /** Appends one signal; false when its `dedupe_key` was already ingested (so ingestion is idempotent). */
  insertSignal(s: Omit<SignalRecord, "id">): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO signals (repo, source, kind, dedupe_key, taint, payload_json, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.repo, s.source, s.kind, s.dedupeKey, s.taint, JSON.stringify(s.payload), s.observedAt);
    return r.changes === 1;
  }

  /** This repo's signals observed at or after `sinceMs`, oldest first. */
  listSignals(sinceMs: number, repo = this.repo): SignalRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM signals WHERE repo = ? AND observed_at >= ? ORDER BY id ASC`)
      .all(repo, sinceMs) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      repo: String(r.repo),
      source: String(r.source),
      kind: String(r.kind),
      dedupeKey: String(r.dedupe_key),
      taint: r.taint as SignalTaint,
      payload: JSON.parse(String(r.payload_json)),
      observedAt: Number(r.observed_at),
    }));
  }

  /** Telemetry anomalies the telemetry Scout recorded since `sinceMs`, across repos, newest first. */
  listTelemetryAnomalies(sinceMs: number): Array<{ repo: string; payload: Record<string, unknown>; observedAt: number }> {
    const rows = this.db
      .prepare(`SELECT repo, payload_json, observed_at FROM signals WHERE kind = 'telemetry_anomaly' AND observed_at >= ? ORDER BY id DESC`)
      .all(sinceMs) as Array<{ repo: string; payload_json: string; observed_at: number }>;
    return rows.map((r) => ({ repo: r.repo, payload: JSON.parse(r.payload_json) as Record<string, unknown>, observedAt: r.observed_at }));
  }

  signalCounts(sinceMs: number, repo = this.repo): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT kind, COUNT(*) AS n FROM signals WHERE repo = ? AND observed_at >= ? GROUP BY kind`)
      .all(repo, sinceMs) as Array<{ kind: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }

  getSignalWatermark(adapter: string, repo = this.repo): { watermark: number; polledAt: number } | null {
    const r = this.db.prepare(`SELECT watermark, polled_at FROM signal_watermarks WHERE repo = ? AND adapter = ?`).get(repo, adapter) as
      | { watermark: number; polled_at: number }
      | null;
    return r ? { watermark: r.watermark, polledAt: r.polled_at } : null;
  }

  setSignalWatermark(adapter: string, watermark: number, now: number, repo = this.repo): void {
    this.db
      .prepare(
        `INSERT INTO signal_watermarks (repo, adapter, watermark, polled_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (repo, adapter) DO UPDATE SET watermark = excluded.watermark, polled_at = excluded.polled_at`,
      )
      .run(repo, adapter, watermark, now);
  }

  hasSignalAction(signalId: number, ruleKey: string): boolean {
    return this.db.prepare(`SELECT 1 FROM signal_actions WHERE signal_id = ? AND rule_key = ?`).get(signalId, ruleKey) !== null;
  }

  /** Actions taken today (local day), across every repo: for one rule when `ruleName` is given, else all. Rejected rows do not count. */
  countSignalActionsToday(now: number, ruleName?: string): number {
    const dayKey = formatDayKey(now, this.timeZone);
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM signal_actions WHERE day_key = ? AND outcome != 'rejected' AND (? IS NULL OR rule_name = ?)`)
      .get(dayKey, ruleName ?? null, ruleName ?? null) as { n: number };
    return r.n;
  }

  /** Claims (signal, rule version) before acting, so the action happens at most once. False when already claimed. */
  claimSignalAction(signalId: number, ruleKey: string, ruleName: string, outcome: string, now: number): boolean {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO signal_actions (signal_id, rule_key, rule_name, day_key, outcome, actioned_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(signalId, ruleKey, ruleName, formatDayKey(now, this.timeZone), outcome, now);
    return r.changes === 1;
  }

  finishSignalAction(signalId: number, ruleKey: string, outcome: string, detail: string | null): void {
    this.db.prepare(`UPDATE signal_actions SET outcome = ?, detail = ? WHERE signal_id = ? AND rule_key = ?`).run(outcome, detail, signalId, ruleKey);
  }

  /** Gives a claim back when the action provably did not happen (a Scout cap), so the signal stays pending. */
  releaseSignalAction(signalId: number, ruleKey: string): void {
    this.db.prepare(`DELETE FROM signal_actions WHERE signal_id = ? AND rule_key = ?`).run(signalId, ruleKey);
  }

  /**
   * Atomically checks daily cap (and once-per-day dedupe for scheduled runs) and reserves
   * a `scout/run` audit slot in a single SQLite transaction (Opus M5).
   */
  tryReserveScoutRun(
    scoutName: string,
    maxRunsPerDay: number,
    oncePerDayForScout: boolean,
    now = Date.now(),
    repo = this.repo,
  ): boolean {
    const dayKey = formatDayKey(now, this.timeZone);
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT actor, payload_json FROM audit_log
           WHERE repo = ? AND topic = 'scout/run' AND ts >= ?`,
        )
        .all(repo, now - 36 * 3600_000) as Array<{ actor: string; payload_json: string }>;

      let todayCount = 0;
      let ranThisScoutToday = false;
      for (const r of rows) {
        const raw = tryParseJson(r.payload_json);
        if (!raw.ok || typeof raw.value !== "object" || raw.value === null) {
          todayCount++;
          continue;
        }
        const p = raw.value as { dayKey?: string };
        if (p.dayKey === dayKey) {
          todayCount++;
          if (r.actor === scoutName) ranThisScoutToday = true;
        }
      }
      if (todayCount >= maxRunsPerDay) return false;
      if (oncePerDayForScout && ranThisScoutToday) return false;

      this.db
        .prepare(
          `INSERT INTO audit_log (ts, repo, topic, issue_number, actor, payload_json)
           VALUES (?, ?, 'scout/run', NULL, ?, ?)`,
        )
        .run(now, repo, scoutName, JSON.stringify({ dayKey, scheduled: oncePerDayForScout }));
      return true;
    });
    return tx();
  }


  recordPitch(input: { autoPocBuild?: boolean; issueNumber: number; scoutName: string; trustHash: string; title: string; titleFp: string; contentSha256: string; pitchJson: string; now?: number; repo?: string }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO pitches (repo, issue_number, scout_name, trust_hash, title, title_fp, content_sha256, filed_at, state_json, state_at, pitch_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.repo ?? this.repo, input.issueNumber, input.scoutName, input.trustHash, input.title, input.titleFp, input.contentSha256, now, JSON.stringify({ kind: "open" }), now, input.pitchJson);
    if (input.autoPocBuild) this.queuePocBuild(input.issueNumber, now, input.repo ?? this.repo);
  }

  /** The most one pitch may be built (owner command or automatic), and the most builds started in any 24 hours across repos. */
  static readonly POC_MAX_BUILDS_PER_PITCH = 2;
  static readonly POC_MAX_BUILDS_PER_DAY = 2;

  /** Marks a freshly filed pitch for an automatic build. The reconciler starts it when the caps and a slot allow. */
  queuePocBuild(issueNumber: number, now = Date.now(), repo = this.repo): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO pitch_pocs (repo, issue_number, ref, auto_queued, state_json, state_at) VALUES (?, ?, ?, 1, ?, ?)`)
      .run(repo, issueNumber, `refs/pitch-poc/${issueNumber}`, JSON.stringify({ kind: "none" }), now);
  }

  /** Builds requested in the 24 hours before `now`, in every repo: PoC builds spend the one subscription. */
  pocBuildsInLastDay(now = Date.now()): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE topic = 'poc/requested' AND ts > ?`).get(now - 86_400_000) as { n: number }).n;
  }

  /**
   * Starts a build if the caps allow: at most POC_MAX_BUILDS_PER_PITCH per pitch and POC_MAX_BUILDS_PER_DAY a day, and none already
   * running. `poc/requested` is written in the same transaction, before any build begins. A cap refusal is audited (`poc/refused_cap`).
   */
  reservePocBuild(issueNumber: number, now = Date.now(), repo = this.repo): { ok: true } | { ok: false; reason: string } {
    const tx = this.db.transaction((): { ok: true } | { ok: false; reason: string } => {
      if (!this.getPitch(issueNumber, repo)) return { ok: false, reason: `no pitch #${issueNumber} in ${repo}` };
      this.db
        .prepare(`INSERT OR IGNORE INTO pitch_pocs (repo, issue_number, ref, state_json, state_at) VALUES (?, ?, ?, ?, ?)`)
        .run(repo, issueNumber, `refs/pitch-poc/${issueNumber}`, JSON.stringify({ kind: "none" }), now);
      const row = this.getPoc(issueNumber, repo)!;
      if (row.state.kind === "building") return { ok: false, reason: "a build is already running for this pitch" };
      const refuse = (scope: "pitch" | "day", reason: string) => {
        this.appendAudit("poc/refused_cap", issueNumber, "archangel", { scope, builds: row.builds }, now, repo);
        return { ok: false as const, reason };
      };
      if (row.builds >= Ledger.POC_MAX_BUILDS_PER_PITCH) return refuse("pitch", `this pitch has used its ${Ledger.POC_MAX_BUILDS_PER_PITCH} builds`);
      if (this.pocBuildsInLastDay(now) >= Ledger.POC_MAX_BUILDS_PER_DAY) return refuse("day", `${Ledger.POC_MAX_BUILDS_PER_DAY} PoC builds were already started in the last 24 hours`);
      const step = this.stepPocState(issueNumber, { t: "build_requested", at: now }, {}, now, repo);
      if (!step.ok) return { ok: false, reason: step.reject };
      this.db.prepare(`UPDATE pitch_pocs SET builds = builds + 1, auto_queued = 0 WHERE repo = ? AND issue_number = ?`).run(repo, issueNumber);
      this.appendAudit("poc/requested", issueNumber, "archangel", { builds: row.builds + 1 }, now, repo);
      return { ok: true };
    });
    return tx();
  }

  /** The only way a PoC changes state: read, `stepPoc`, compare-and-set on `version`. An illegal move changes nothing and is audited. */
  stepPocState(
    issueNumber: number,
    ev: PocEvent,
    extra: { diffStat?: string; costUsd?: number } = {},
    now = Date.now(),
    repo = this.repo,
  ): { ok: true; state: PocState } | { ok: false; reject: string } {
    const row = this.db.prepare(`SELECT state_json, version FROM pitch_pocs WHERE repo = ? AND issue_number = ?`).get(repo, issueNumber) as
      | { state_json: string; version: number }
      | undefined;
    if (!row) return { ok: false, reject: `no PoC for pitch #${issueNumber}` };
    const state = PocStateSchema.parse(JSON.parse(row.state_json));
    const step = stepPoc(state, ev);
    if (!step.ok) {
      this.appendAudit("poc/illegal_transition", issueNumber, "archangel", { from: state.kind, event: ev.t, reason: step.reject.slice(0, 200) }, now, repo);
      return step;
    }
    const res = this.db
      .prepare(
        `UPDATE pitch_pocs SET state_json = ?, state_at = ?, version = version + 1, diff_stat = COALESCE(?, diff_stat), cost_usd = cost_usd + ?
         WHERE repo = ? AND issue_number = ? AND version = ?`,
      )
      .run(JSON.stringify(step.next), now, extra.diffStat ?? null, extra.costUsd ?? 0, repo, issueNumber, row.version);
    if (res.changes !== 1) return { ok: false, reject: "the PoC changed concurrently; retry" };
    return { ok: true, state: step.next };
  }

  getPoc(issueNumber: number, repo = this.repo): PocRow | null {
    const r = this.db.prepare(`SELECT * FROM pitch_pocs WHERE repo = ? AND issue_number = ?`).get(repo, issueNumber) as PocDbRow | undefined;
    return r ? toPocRow(r) : null;
  }

  /** Every PoC row across repos, for the dashboard and the reconciler's level-triggered scan. */
  listPocs(): PocRow[] {
    return (this.db.prepare(`SELECT * FROM pitch_pocs ORDER BY rowid`).all() as PocDbRow[]).map(toPocRow);
  }

  recordPitchAttachment(input: { issueNumber: number; sha256: string; kind: "repo" | "capture"; mime: string; width: number; height: number; bytes: number; caption: string; source: string; now?: number; repo?: string }): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO pitch_attachments (repo, issue_number, sha256, kind, mime, width, height, bytes, caption, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.repo ?? this.repo, input.issueNumber, input.sha256, input.kind, input.mime, input.width, input.height, input.bytes, input.caption, input.source, input.now ?? Date.now());
  }

  /** A new preview run replaces the old screenshots of the pitch (the files stay: they are content-addressed). */
  clearPitchCaptures(issueNumber: number, repo = this.repo): void {
    this.db.prepare(`DELETE FROM pitch_attachments WHERE repo = ? AND issue_number = ? AND kind = 'capture'`).run(repo, issueNumber);
  }

  listPitchAttachments(): Array<{ repo: string; issueNumber: number; sha256: string; kind: string; mime: string; width: number; height: number; caption: string; source: string }> {
    return (
      this.db.prepare(`SELECT repo, issue_number, sha256, kind, mime, width, height, caption, source FROM pitch_attachments ORDER BY created_at, rowid`).all() as Array<{ repo: string; issue_number: number; sha256: string; kind: string; mime: string; width: number; height: number; caption: string; source: string }>
    ).map((r) => ({ repo: r.repo, issueNumber: r.issue_number, sha256: r.sha256, kind: r.kind, mime: r.mime, width: r.width, height: r.height, caption: r.caption, source: r.source }));
  }

  /** The stored image type for a content hash, or null when no pitch has it. The asset route serves nothing else. */
  pitchAssetMime(sha256: string): string | null {
    const r = this.db.prepare(`SELECT mime FROM pitch_attachments WHERE sha256 = ? LIMIT 1`).get(sha256) as { mime: string } | undefined;
    return r?.mime ?? null;
  }

  /**
   * The only way a pitch changes state: read, `stepPitch`, compare-and-set on `version`. An illegal move changes nothing and writes a
   * `pitch/illegal_transition` audit row. Returns the new state, or the reason it was refused.
   */
  stepPitchState(issueNumber: number, ev: PitchEvent, now = Date.now(), repo = this.repo): { ok: true; state: PitchState } | { ok: false; reject: string } {
    const row = this.db.prepare(`SELECT state_json, version FROM pitches WHERE repo = ? AND issue_number = ?`).get(repo, issueNumber) as
      | { state_json: string; version: number }
      | undefined;
    if (!row) return { ok: false, reject: `no pitch #${issueNumber}` };
    const state = PitchStateSchema.parse(JSON.parse(row.state_json));
    const step = stepPitch(state, ev);
    if (!step.ok) {
      this.appendAudit("pitch/illegal_transition", issueNumber, "archangel", { from: state.kind, event: ev.t, reason: step.reject.slice(0, 200) }, now, repo);
      return step;
    }
    const res = this.db
      .prepare(`UPDATE pitches SET state_json = ?, state_at = ?, version = version + 1 WHERE repo = ? AND issue_number = ? AND version = ?`)
      .run(JSON.stringify(step.next), now, repo, issueNumber, row.version);
    if (res.changes !== 1) return { ok: false, reject: "the pitch changed concurrently; retry" };
    return { ok: true, state: step.next };
  }

  /** Pitches whose issue is no longer open become declined (nothing promoted) or promoted (some slices were). Returns the declined ones. */
  syncPitchStatuses(openIssueNumbers: readonly number[], now = Date.now(), repo = this.repo): Array<{ issueNumber: number; filedAt: number }> {
    const open = new Set(openIssueNumbers);
    const declined: Array<{ issueNumber: number; filedAt: number }> = [];
    for (const row of this.db.prepare(`SELECT issue_number, filed_at FROM pitches WHERE repo = ? AND state IN ('open', 'partially_promoted')`).all(repo) as Array<{ issue_number: number; filed_at: number }>) {
      if (open.has(row.issue_number)) continue;
      const r = this.stepPitchState(row.issue_number, { t: "closed" }, now, repo);
      if (r.ok && r.state.kind === "declined") declined.push({ issueNumber: row.issue_number, filedAt: row.filed_at });
    }
    return declined;
  }

  /** Undecided pitches (open or partially promoted) filed at or before `cutoffMs`: candidates for the 14-day expiry. */
  listOpenPitchesFiledBefore(cutoffMs: number, repo = this.repo): Array<{ issueNumber: number; filedAt: number }> {
    return (
      this.db
        .prepare(`SELECT issue_number, filed_at FROM pitches WHERE repo = ? AND state IN ('open', 'partially_promoted') AND filed_at <= ? ORDER BY filed_at ASC`)
        .all(repo, cutoffMs) as Array<{ issue_number: number; filed_at: number }>
    ).map((r) => ({ issueNumber: r.issue_number, filedAt: r.filed_at }));
  }

  /** The bot closed a pitch nobody decided in 14 days. */
  markPitchExpired(issueNumber: number, now = Date.now(), repo = this.repo): void {
    this.stepPitchState(issueNumber, { t: "expired", at: now }, now, repo);
  }

  /** Every pitch row across repos with its stored JSON and state, newest first, for the dashboard's Pitches page. */
  listPitchRows(): Array<{ repo: string; issueNumber: number; scoutName: string; title: string; filedAt: number; stateAt: number; stateJson: string; pitchJson: string }> {
    return (
      this.db.prepare(`SELECT repo, issue_number, scout_name, title, filed_at, state_at, state_json, pitch_json FROM pitches ORDER BY filed_at DESC`).all() as Array<{
        repo: string;
        issue_number: number;
        scout_name: string;
        title: string;
        filed_at: number;
        state_at: number;
        state_json: string;
        pitch_json: string;
      }>
    ).map((r) => ({ repo: r.repo, issueNumber: r.issue_number, scoutName: r.scout_name, title: r.title, filedAt: r.filed_at, stateAt: r.state_at, stateJson: r.state_json, pitchJson: r.pitch_json }));
  }

  /** Undecided pitches across every repo, oldest first, for the daily digest. */
  listOpenPitches(): Array<{ repo: string; issueNumber: number; scoutName: string; title: string; filedAt: number }> {
    return (
      this.db.prepare(`SELECT repo, issue_number, scout_name, title, filed_at FROM pitches WHERE state IN ('open', 'partially_promoted') ORDER BY filed_at ASC`).all() as Array<{
        repo: string;
        issue_number: number;
        scout_name: string;
        title: string;
        filed_at: number;
      }>
    ).map((r) => ({ repo: r.repo, issueNumber: r.issue_number, scoutName: r.scout_name, title: r.title, filedAt: r.filed_at }));
  }

  /**
   * Pitch outcomes for the dashboard: counts of pitches filed in the window by state, vetoes (audit rows: a vetoed pitch is
   * never filed), and the promotion rate over the most recent decided pitches (V7's entry trigger is at least 1 in 3 over 6).
   */
  pitchMetrics(sinceMs: number, repo = this.repo): PitchMetrics {
    const rows = this.db
      .prepare(`SELECT state, filed_at FROM pitches WHERE repo = ? ORDER BY filed_at DESC, issue_number DESC`)
      .all(repo) as Array<{ state: PitchStateKind; filed_at: number }>;
    const inWindow = rows.filter((r) => r.filed_at >= sinceMs);
    const undecided = (k: PitchStateKind) => k === "open" || k === "partially_promoted";
    const promoted = (k: PitchStateKind) => k === "promoted" || k === "partially_promoted";
    const decided = rows.filter((r) => !undecided(r.state)).slice(0, PITCH_RATE_WINDOW);
    return {
      filed: inWindow.length,
      promoted: inWindow.filter((r) => promoted(r.state)).length,
      declined: inWindow.filter((r) => r.state === "declined").length,
      expired: inWindow.filter((r) => r.state === "expired").length,
      open: rows.filter((r) => undecided(r.state)).length,
      vetoed: (this.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE repo = ? AND topic = 'pitch/vetoed' AND ts >= ?`).get(repo, sinceMs) as { n: number }).n,
      lastDecided: decided.length,
      lastDecidedPromoted: decided.filter((r) => r.state === "promoted").length,
    };
  }

  setPitchDeclineReason(issueNumber: number, reason: string, repo = this.repo): void {
    this.stepPitchState(issueNumber, { t: "decline_reason", reason }, Date.now(), repo);
  }

  getPitch(
    issueNumber: number,
    repo = this.repo,
  ): { issueNumber: number; state: PitchState; contentSha256: string; pitchJson: string } | null {
    const r = this.db
      .prepare(`SELECT issue_number, state_json, content_sha256, pitch_json FROM pitches WHERE repo = ? AND issue_number = ?`)
      .get(repo, issueNumber) as { issue_number: number; state_json: string; content_sha256: string; pitch_json: string } | undefined;
    return r ? { issueNumber: r.issue_number, state: PitchStateSchema.parse(JSON.parse(r.state_json)), contentSha256: r.content_sha256, pitchJson: r.pitch_json } : null;
  }

  /**
   * Only `archangel pitch promote` (the owner's `gh`) calls this. Records which slices (0-based) became owner-authored issues: the
   * pitch is `partially_promoted` until every one of `total` is, then `promoted`. Counts as promoted for the pause rule either way.
   * Refused (and audited) for a decided pitch or a slice that is already promoted.
   */
  markPitchSlicesPromoted(issueNumber: number, slices: readonly number[], total: number, now = Date.now(), repo = this.repo): boolean {
    return this.stepPitchState(issueNumber, { t: "slices_promoted", slices: [...slices], total }, now, repo).ok;
  }


  /**
   * Adds a case to the vault, or updates an existing one. A new case goes to dev or held-out by `splitOf`; an owner dispute is
   * always held-out; and a held-out case never moves back to dev.
   */
  upsertEvalCase(
    c: { caseId: string; repo: string; issueNumber: number; kind: string; label: "good" | "bad"; dispute: boolean; headSha: string },
    splitOf: (caseId: string) => "dev" | "heldout",
    now = Date.now(),
  ): "dev" | "heldout" {
    const existing = this.db.prepare(`SELECT split FROM eval_vault WHERE case_id = ?`).get(c.caseId) as { split: "dev" | "heldout" } | undefined;
    const split = c.dispute || existing?.split === "heldout" ? "heldout" : (existing?.split ?? splitOf(c.caseId));
    this.db
      .prepare(
        `INSERT INTO eval_vault (case_id, repo, issue_number, kind, label, dispute, split, head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(case_id) DO UPDATE SET label = excluded.label, dispute = MAX(dispute, excluded.dispute), split = excluded.split`,
      )
      .run(c.caseId, c.repo, c.issueNumber, c.kind, c.label, c.dispute ? 1 : 0, split, c.headSha, now);
    return split;
  }

  getBenchResult(cacheKey: string, caseId: string): unknown | null {
    const row = this.db.prepare("SELECT result_json FROM bench_results WHERE cache_key = ? AND case_id = ?").get(cacheKey, caseId) as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) : null;
  }

  putBenchResult(cacheKey: string, caseId: string, result: unknown, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO bench_results (cache_key, case_id, result_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key, case_id) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at")
      .run(cacheKey, caseId, JSON.stringify(result), now);
  }

  getEvalResult(promptHash: string, caseId: string): { verdict: "approve" | "veto"; vendors: string } | null {
    return (this.db.prepare(`SELECT verdict, vendors FROM eval_results WHERE prompt_hash = ? AND case_id = ?`).get(promptHash, caseId) as { verdict: "approve" | "veto"; vendors: string } | undefined) ?? null;
  }

  putEvalResult(promptHash: string, caseId: string, verdict: "approve" | "veto", vendors: string, now = Date.now()): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO eval_results (prompt_hash, case_id, verdict, vendors, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(promptHash, caseId, verdict, vendors, now);
  }

  /**
   * Gives back the budget an Attempt consumed when it ended without doing real work (an owner pause/stop or a policy halt):
   * a flapping control label or workflow must not exhaust `max*AttemptsPerThread` with nothing built.
   */
  refundAttemptCounts(issueNumber: number, kind: AttemptKind, repo = this.repo): void {
    this.db
      .prepare(
        `UPDATE threads SET implement_count = MAX(0, implement_count - 1),
           revision_count = MAX(0, revision_count - ?), rebase_count = MAX(0, rebase_count - ?)
         WHERE repo = ? AND issue_number = ?`,
      )
      .run(kind === "revise" ? 1 : 0, kind === "rebase" ? 1 : 0, repo, issueNumber);
  }

  /** Stores a new plan version for the Thread (text already vetted by `vetPlan`). */
  addThreadPlan(issueNumber: number, text: string, now = Date.now(), repo = this.repo): { version: number; sha256: string } {
    const sha256 = planSha256(text);
    const row = this.db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM thread_plans WHERE repo = ? AND issue_number = ?`).get(repo, issueNumber) as { v: number };
    this.db
      .prepare(`INSERT INTO thread_plans (repo, issue_number, version, sha256, plan_text, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(repo, issueNumber, row.v, sha256, text, now);
    return { version: row.v, sha256 };
  }

  /** The newest plan, approved or not. */
  latestThreadPlan(issueNumber: number, repo = this.repo): { version: number; sha256: string; text: string; createdAt: number; approvedAt: number | null } | null {
    const r = this.db
      .prepare(`SELECT version, sha256, plan_text, created_at, approved_at FROM thread_plans WHERE repo = ? AND issue_number = ? ORDER BY version DESC LIMIT 1`)
      .get(repo, issueNumber) as { version: number; sha256: string; plan_text: string; created_at: number; approved_at: number | null } | undefined;
    return r ? { version: r.version, sha256: r.sha256, text: r.plan_text, createdAt: r.created_at, approvedAt: r.approved_at } : null;
  }

  countThreadPlans(issueNumber: number, repo = this.repo): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM thread_plans WHERE repo = ? AND issue_number = ?`).get(repo, issueNumber) as { n: number }).n;
  }

  /** Pins a plan version as approved; a version already approved keeps its first approval time. */
  approveThreadPlan(issueNumber: number, version: number, now = Date.now(), repo = this.repo): void {
    this.db
      .prepare(`UPDATE thread_plans SET approved_at = COALESCE(approved_at, ?) WHERE repo = ? AND issue_number = ? AND version = ?`)
      .run(now, repo, issueNumber, version);
  }

  /** The pinned plan later Attempts implement, or null when none is approved. */
  approvedThreadPlan(issueNumber: number, repo = this.repo): { version: number; sha256: string; text: string } | null {
    const r = this.db
      .prepare(`SELECT version, sha256, plan_text FROM thread_plans WHERE repo = ? AND issue_number = ? AND approved_at IS NOT NULL ORDER BY version DESC LIMIT 1`)
      .get(repo, issueNumber) as { version: number; sha256: string; plan_text: string } | undefined;
    return r ? { version: r.version, sha256: r.sha256, text: r.plan_text } : null;
  }

  addThreadDependency(issueNumber: number, dependsOn: number, now = Date.now(), repo = this.repo): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO thread_dependencies (repo, issue_number, depends_on, created_at) VALUES (?, ?, ?, ?)`)
      .run(repo, issueNumber, dependsOn, now);
  }

  /** The issue this one waits for, or null. */
  getThreadDependency(issueNumber: number, repo = this.repo): number | null {
    const r = this.db.prepare(`SELECT depends_on FROM thread_dependencies WHERE repo = ? AND issue_number = ?`).get(repo, issueNumber) as
      | { depends_on: number }
      | undefined;
    return r ? r.depends_on : null;
  }

  clearThreadDependency(issueNumber: number, repo = this.repo): void {
    this.db.prepare(`DELETE FROM thread_dependencies WHERE repo = ? AND issue_number = ?`).run(repo, issueNumber);
  }

  countOpenPitches(repo = this.repo): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM pitches WHERE repo = ? AND state IN ('open', 'partially_promoted')`).get(repo) as { n: number }).n;
  }

  /** Titles of pitches that are open or were decided in the last `days` days (for the prompt and the duplicate check). */
  recentPitchTitles(days: number, now = Date.now(), repo = this.repo): Array<{ title: string; titleFp: string; declineReason: string | null }> {
    return (
      this.db
        .prepare(
          `SELECT title, title_fp, json_extract(state_json, '$.reason') AS decline_reason FROM pitches
           WHERE repo = ? AND (state IN ('open', 'partially_promoted') OR state_at >= ?) ORDER BY filed_at DESC`,
        )
        .all(repo, now - days * 86_400_000) as Array<{ title: string; title_fp: string; decline_reason: string | null }>
    ).map((r) => ({ title: r.title, titleFp: r.title_fp, declineReason: r.decline_reason }));
  }

  /** A pitch Scout pauses for one exact `trustHash` after `n` consecutive pitches that were not promoted. Editing the Scout (a new hash) resumes it. */
  isPitchScoutPaused(scoutName: string, trustHash: string, n: number, repo = this.repo): boolean {
    return this.pitchUnpromotedStreak(scoutName, trustHash, n, repo) === n;
  }

  /** How many of this Scout's latest pitches (for one exact `trustHash`, newest first, at most `cap`) in a row were not promoted. */
  pitchUnpromotedStreak(scoutName: string, trustHash: string, cap: number, repo = this.repo): number {
    const rows = this.db
      .prepare(`SELECT state FROM pitches WHERE repo = ? AND scout_name = ? AND trust_hash = ? ORDER BY filed_at DESC, issue_number DESC LIMIT ?`)
      .all(repo, scoutName, trustHash, cap) as Array<{ state: PitchStateKind }>;
    const firstPromoted = rows.findIndex((r) => r.state === "promoted" || r.state === "partially_promoted");
    return firstPromoted === -1 ? rows.length : firstPromoted;
  }

  /** When this Scout last started a run, or null. */
  lastScoutRunAt(scoutName: string, repo = this.repo): number | null {
    const row = this.db.prepare(`SELECT MAX(ts) AS ts FROM audit_log WHERE repo = ? AND topic = 'scout/run' AND actor = ?`).get(repo, scoutName) as { ts: number | null };
    return row.ts;
  }

  /**
   * Escalations the owner answered today (local day in the Ledger's timezone): each is one `escalation/raised` row (its code) paired with
   * the first audit row by actor 'owner' on the same Thread after it. Read-only.
   */
  ownerAnswersToday(now: number): Array<{ repo: string; issueNumber: number; code: string; answeredAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT o.repo AS repo, o.issue_number AS issue_number, MIN(o.ts) AS ts, e.payload_json AS payload_json
           FROM audit_log o
           JOIN audit_log e ON e.id = (SELECT MAX(id) FROM audit_log WHERE repo = o.repo AND issue_number = o.issue_number AND topic = 'escalation/raised' AND id < o.id)
          WHERE o.actor = 'owner' AND o.issue_number IS NOT NULL AND o.ts >= ?
          GROUP BY e.id
          ORDER BY ts DESC`,
      )
      .all(now - 2 * 86_400_000) as Array<{ repo: string; issue_number: number; ts: number; payload_json: string }>;
    const today = this.dayKeyOf(now);
    const out: Array<{ repo: string; issueNumber: number; code: string; answeredAt: number }> = [];
    for (const r of rows) {
      const parsed = tryParseJson(r.payload_json);
      const code = parsed.ok && typeof (parsed.value as { code?: unknown }).code === "string" ? (parsed.value as { code: string }).code : null;
      if (code !== null && this.dayKeyOf(r.ts) === today) out.push({ repo: r.repo, issueNumber: r.issue_number, code, answeredAt: r.ts });
    }
    return out;
  }

  /** The IANA timezone this Ledger's "today" is measured in. */
  get dayTimeZone(): string {
    return this.timeZone;
  }

  /** Did this Scout start a run at or after `sinceMs`? (weekly schedule) */
  scoutRanSince(scoutName: string, sinceMs: number, repo = this.repo): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM audit_log WHERE repo = ? AND topic = 'scout/run' AND actor = ? AND ts >= ? LIMIT 1`)
        .get(repo, scoutName, sinceMs),
    );
  }


  dayKeyOf(ts: number): string {
    return formatDayKey(ts, this.timeZone);
  }

  digestSentFor(dayKey: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM audit_log WHERE topic = 'digest/sent' AND json_extract(payload_json, '$.dayKey') = ? LIMIT 1`)
      .get(dayKey);
    return Boolean(row);
  }

  markDigestSent(dayKey: string, now = Date.now()): void {
    this.appendAudit("digest/sent", null, "archangel", { dayKey }, now, null);
  }

  /**
   * Digest inputs across ALL repos in this Ledger. Needs You age is time since the Thread's last transition (`updated_at`).
   * "Yesterday" is the local day before today in the Ledger timezone. Reverts are yesterday's merges whose main-watch is now red
   * (no timestamp is recorded for the red transition itself). Owner merges come from `thread/owner_merged` audit rows.
   */
  collectDigestInput(now: number): DigestInput {
    const yKey = formatDayKey(now - 86_400_000, this.timeZone);
    // Each figure is computed on its own: a failed query makes that figure null ("unavailable"), never a zero or an empty list.
    const attempt = <T>(f: () => T): T | null => {
      try {
        return f();
      } catch (_err) {
        return null;
      }
    };
    const needsYou = attempt(() =>
      this.listAllThreads(["needs_you"]).flatMap((t) =>
        t.phase.kind === "needs_you"
          ? [{ repo: t.repo, issueNumber: t.issueNumber, title: t.title, code: t.phase.code, since: t.updatedAt }]
          : [],
      ),
    );
    const merges = attempt(() =>
      (this.db.prepare(`SELECT * FROM merges WHERE day_key = ? AND shadow_only = 0`).all(yKey) as Record<string, unknown>[]).map(mapMerge),
    );
    const ownerMerges = attempt(
      () =>
        (
          this.db
            .prepare(`SELECT ts FROM audit_log WHERE topic = 'thread/owner_merged' AND ts >= ?`)
            .all(now - 3 * 86_400_000) as Array<{ ts: number }>
        ).filter((r) => formatDayKey(r.ts, this.timeZone) === yKey).length,
    );
    const spendUsd = attempt(
      () => ((this.db.prepare(`SELECT usd FROM daily_spend WHERE day_key = ?`).get(yKey) as { usd: number } | undefined)?.usd ?? 0),
    );
    const proposals = attempt(() =>
      (
        this.db
          .prepare(
            `SELECT p.repo, p.issue_number, p.scout_name FROM scout_proposals p
             LEFT JOIN threads t ON t.repo = p.repo AND t.issue_number = p.issue_number
             WHERE t.issue_number IS NULL ORDER BY p.created_at ASC`,
          )
          .all() as Array<{ repo: string; issue_number: number; scout_name: string }>
      ).map((r) => ({ repo: r.repo, issueNumber: r.issue_number, scoutName: r.scout_name })),
    );
    const faults = attempt(() => this.listHealthFaults(now).map((f) => ({ repo: f.repo, category: f.category, recent24h: f.recent24h, lastError: f.lastError })));
    const pitches = attempt(() => this.listOpenPitches().map((p) => ({ repo: p.repo, issueNumber: p.issueNumber, scoutName: p.scoutName, since: p.filedAt })));
    const draftReverts = attempt(() =>
      (
        this.db
          .prepare(`SELECT repo, payload_json FROM audit_log WHERE topic = 'correction_draft/revert_flag' AND ts >= ? ORDER BY id ASC`)
          .all(now - 14 * 86_400_000) as Array<{ repo: string; payload_json: string }>
      ).map((r) => {
        const p = JSON.parse(r.payload_json) as { category: string; url: string; before: number; after: number };
        return { repo: r.repo, category: p.category, url: p.url, before: p.before, after: p.after };
      }),
    );
    return {
      now,
      needsYou,
      yesterday: {
        autonomousMerges: merges === null ? null : merges.length,
        ownerMerges,
        reverts: merges === null ? null : merges.filter((x) => x.mainWatch.kind === "red").length,
        spendUsd,
      },
      proposals,
      pitches,
      faults,
      draftReverts,
    };
  }

  /** Cached `EffectiveWorkflow` JSON per repo, as written by each Reconciler tick (`workflow:<repo>`). */
  /** `workflow` is null when the stored text is not JSON (the caller treats that as unreadable, never as a crash). */
  listCachedWorkflows(): Array<{ repo: string; workflow: unknown }> {
    const rows = this.db.prepare(`SELECT key, value FROM system_state WHERE key LIKE 'workflow:%'`).all() as Array<{ key: string; value: string }>;
    return rows.map((r) => {
      const parsedWf = tryParseJson(r.value);
      const workflow: unknown = parsedWf.ok ? parsedWf.value : null;
      return { repo: r.key.slice("workflow:".length), workflow };
    });
  }

  /** Stage-by-stage figures for the Pipeline view: SQL over existing tables, windowed on Thread creation / event time. */
  computeStageMetrics(repo: string, sinceMs: number, now = Date.now()): StageMetrics {
    const LANDED = ["merged", "owner_merged", "reverted"];
    const threads = this.listThreads(undefined, repo).filter((t) => t.createdAt >= sinceMs);
    const landed = (t: ThreadRecord) => t.phase.kind === "done" && LANDED.includes(t.phase.outcome);
    // A revert is a red main-watch on one of the Thread's merges (nothing ever sets the `reverted` outcome), as computeOutcomeMetrics counts it.
    const redIssues = new Set(
      (this.db.prepare(`SELECT issue_number FROM merges WHERE repo = ? AND json_extract(main_watch_json, '$.kind') = 'red'`).all(repo) as Array<{ issue_number: number }>).map(
        (r) => r.issue_number,
      ),
    );
    const reverted = (t: ThreadRecord) => (t.phase.kind === "done" && t.phase.outcome === "reverted") || redIssues.has(t.issueNumber);
    const count = (sql: string, ...params: SQLQueryBindings[]) => (this.db.prepare(sql).get(...params) as { n: number }).n;
    const auditCount = (topic: string, actor?: string) =>
      count(
        `SELECT COUNT(*) AS n FROM audit_log WHERE repo = ? AND topic = ? AND ts >= ?${actor ? " AND actor = ?" : ""}`,
        ...[repo, topic, sinceMs, ...(actor ? [actor] : [])],
      );

    const queued = threads.filter((t) => t.phase.kind === "queued");
    const rejections: Record<string, number> = {};
    for (const r of this.db
      .prepare(`SELECT topic, COUNT(*) AS n FROM audit_log WHERE repo = ? AND topic LIKE 'intake/rejected_%' AND ts >= ? GROUP BY topic`)
      .all(repo, sinceMs) as Array<{ topic: string; n: number }>) {
      rejections[r.topic.slice("intake/rejected_".length)] = r.n;
    }

    const threadByIssue = new Map(this.listThreads(undefined, repo).map((t) => [t.issueNumber, t]));
    const scouts: StageMetrics["scouts"] = {};
    const scoutOf = (name: string) => (scouts[name] ??= { runs: 0, secretsBlocked: 0, filed: 0, becameThread: 0, merged: 0, reverted: 0 });
    for (const r of this.db
      .prepare(`SELECT actor, COUNT(*) AS n FROM audit_log WHERE repo = ? AND topic = 'scout/run' AND ts >= ? GROUP BY actor`)
      .all(repo, sinceMs) as Array<{ actor: string; n: number }>) scoutOf(r.actor).runs = r.n;
    for (const r of this.db
      .prepare(`SELECT actor, COUNT(*) AS n FROM audit_log WHERE repo = ? AND topic = 'scout/secret_blocked' AND ts >= ? GROUP BY actor`)
      .all(repo, sinceMs) as Array<{ actor: string; n: number }>) scoutOf(r.actor).secretsBlocked = r.n;
    for (const p of this.db
      .prepare(`SELECT scout_name, issue_number FROM scout_proposals WHERE repo = ? AND created_at >= ?`)
      .all(repo, sinceMs) as Array<{ scout_name: string; issue_number: number }>) {
      const sc = scoutOf(p.scout_name);
      sc.filed++;
      const t = threadByIssue.get(p.issue_number);
      if (t) {
        sc.becameThread++;
        if (landed(t)) sc.merged++;
        if (reverted(t)) sc.reverted++;
      }
    }

    const workClass: StageMetrics["workClass"] = {
      bugfix: { threads: 0, merged: 0, attemptsPerMerge: null },
      feature: { threads: 0, merged: 0, attemptsPerMerge: null },
      chore: { threads: 0, merged: 0, attemptsPerMerge: null },
    };
    const attemptsOf = this.db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE repo = ? AND issue_number = ?`);
    const attemptTotals = { bugfix: 0, feature: 0, chore: 0 };
    for (const t of threads) {
      const cls = workClassOfBranch(t.branchName);
      workClass[cls].threads++;
      if (landed(t)) {
        workClass[cls].merged++;
        attemptTotals[cls] += (attemptsOf.get(repo, t.issueNumber) as { n: number }).n;
      }
    }
    for (const cls of ["bugfix", "feature", "chore"] as const) {
      const m = workClass[cls].merged;
      workClass[cls].attemptsPerMerge = m > 0 ? Number((attemptTotals[cls] / m).toFixed(2)) : null;
    }

    const attemptRows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM attempts WHERE repo = ? AND started_at >= ? GROUP BY status`)
      .all(repo, sinceMs) as Array<{ status: string; n: number }>;
    const attemptsBy = (st: string) => attemptRows.find((r) => r.status === st)?.n ?? 0;
    const escalations: Record<string, number> = {};
    const byDecisionClass: Record<string, number> = {};
    for (const t of threads) {
      if (t.phase.kind !== "needs_you") continue;
      escalations[t.phase.code] = (escalations[t.phase.code] ?? 0) + 1;
      const cls = describeEscalation(t.phase.code).decisionClass;
      byDecisionClass[cls] = (byDecisionClass[cls] ?? 0) + 1;
    }

    const byVendor: StageMetrics["review"]["byVendor"] = {};
    for (const r of this.db
      .prepare(`SELECT vendor, verdict, COUNT(*) AS n FROM reviews WHERE repo = ? AND created_at >= ? GROUP BY vendor, verdict`)
      .all(repo, sinceMs) as Array<{ vendor: string; verdict: string; n: number }>) {
      const b = (byVendor[r.vendor] ??= { approve: 0, veto: 0 });
      if (r.verdict === "approve") b.approve += r.n;
      else b.veto += r.n;
    }

    const allMerges = (
      this.db.prepare(`SELECT * FROM merges WHERE repo = ? AND created_at >= ?`).all(repo, sinceMs) as Record<string, unknown>[]
    ).map(mapMerge);
    const merges = allMerges.filter((m) => !m.shadowOnly);

    const byWorkflowSha: StageMetrics["byWorkflowSha"] = {};
    for (const t of threads) {
      const k = t.workflowSha256 ?? "none";
      const b = (byWorkflowSha[k] ??= { threads: 0, merged: 0, reverted: 0 });
      b.threads++;
      if (landed(t)) b.merged++;
      if (reverted(t)) b.reverted++;
    }

    return {
      windowDays: sinceMs > 0 ? Math.max(1, Math.round((now - sinceMs) / 86_400_000)) : 0,
      intake: {
        queued: queued.length,
        oldestQueuedAgeSec: queued.length > 0 ? Math.max(0, Math.round((now - Math.min(...queued.map((t) => t.updatedAt))) / 1000)) : null,
        rejections,
      },
      scouts,
      promotion: {
        autoPromotionsLast24h: this.countRecentAutoPromotions(now, repo),
        autoPromotionsInWindow: count(`SELECT COUNT(*) AS n FROM scout_proposals WHERE repo = ? AND auto_promoted = 1 AND created_at >= ?`, repo, sinceMs),
      },
      pitches: this.pitchMetrics(sinceMs, repo),
      workClass,
      gate: { attempts: { total: attemptRows.reduce((a, r) => a + r.n, 0), succeeded: attemptsBy("succeeded"), failed: attemptsBy("failed") }, escalations },
      review: { byVendor, outages: auditCount("review/outage_started") },
      landing: {
        autoMerged: merges.length,
        ownerMerged: threads.filter((t) => t.phase.kind === "done" && t.phase.outcome === "owner_merged").length,
        reverts: merges.filter((m) => m.mainWatch.kind === "red").length,
        // Shadow Mode verdicts are shadow_only rows; the owner's disagreements land on those, so count every merge row in the window.
        disagreements: allMerges.filter((m) => m.disagreed).length,
        autonomyCapHits: auditCount("autonomy/cap_reached"),
      },
      needsYou: { byDecisionClass },
      byWorkflowSha,
      factoryRetries: this.factoryRetryMetrics(repo, sinceMs),
    };
  }

  private factoryRetryMetrics(repo: string, sinceMs: number): StageMetrics["factoryRetries"] {
    const zero = () => Object.fromEntries(FACTORY_OUTCOMES.map((o) => [o, 0])) as Record<FactoryOutcome, number>;
    const out: StageMetrics["factoryRetries"] = { total: 0, byOutcome: zero(), byCode: {} };
    for (const r of this.factoryRetryOutcomes({ repo }).filter((x) => x.at >= sinceMs)) {
      out.total++;
      out.byOutcome[r.outcome]++;
      (out.byCode[r.code] ??= zero())[r.outcome]++;
    }
    return out;
  }

  /**
   * Last `days` local days (oldest first): fixes that landed (by the Thread's final transition) and their rework attempts
   * (Attempts beyond the first). Read-only; used by the dashboard.
   */
  dailyOutcomes(days: number, now: number): Array<{ day: string; merged: number; reworkAttempts: number }> {
    const series = Array.from({ length: days }, (_, i) => ({
      day: formatDayKey(now - (days - 1 - i) * 86_400_000, this.timeZone),
      merged: 0,
      reworkAttempts: 0,
    }));
    const byDay = new Map(series.map((d) => [d.day, d]));
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE repo = ? AND issue_number = ?`);
    for (const t of this.listAllThreads(["done"])) {
      if (t.phase.kind !== "done" || !["merged", "owner_merged", "reverted"].includes(t.phase.outcome)) continue;
      const bucket = byDay.get(formatDayKey(t.updatedAt, this.timeZone));
      if (!bucket) continue;
      bucket.merged++;
      bucket.reworkAttempts += Math.max(0, (count.get(t.repo, t.issueNumber) as { n: number }).n - 1);
    }
    return series;
  }


  /**
   * Outcome metrics over the merged fixes among `threads` (the window and repo filters are applied by the caller, on Thread creation time).
   * A merged fix is a Thread that landed on main: done with outcome merged, owner_merged or reverted.
   * Cost and attempt figures cover all Attempts and reviews of those Threads, including failed ones that preceded the merge.
   * A merge is "disputed" if the owner marked it disagreed or main-watch went red; vendor agreement counts merges the vendor approved
   * (review on the merged head sha) that were not disputed. Ratios are null when the denominator is 0.
   */
  private computeOutcomeMetrics(threads: ThreadRecord[]): OutcomeMetrics {
    const landed = threads.filter(
      (t) =>
        t.phase.kind === "done" &&
        (t.phase.outcome === "merged" || t.phase.outcome === "owner_merged" || t.phase.outcome === "reverted"),
    );
    const ratio = (n: number, d: number): number | null => (d > 0 ? Number((n / d).toFixed(3)) : null);
    let meteredUsd = 0;
    let attempts = 0;
    let attemptMs = 0;
    let rework = 0;
    let reverts = 0;
    const vendors: Record<string, { approvedMerges: number; undisputed: number }> = {};
    for (const t of landed) {
      const a = this.db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS usd,
                  COALESCE(SUM(CASE WHEN finished_at >= started_at THEN finished_at - started_at ELSE 0 END), 0) AS ms
           FROM attempts WHERE repo = ? AND issue_number = ?`,
        )
        .get(t.repo, t.issueNumber) as { n: number; usd: number; ms: number };
      const r = this.db
        .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM reviews WHERE repo = ? AND issue_number = ?`)
        .get(t.repo, t.issueNumber) as { usd: number };
      meteredUsd += a.usd + r.usd;
      attempts += a.n;
      attemptMs += a.ms;
      rework += Math.max(0, a.n - 1);

      const merges = (
        this.db
          .prepare(`SELECT * FROM merges WHERE repo = ? AND issue_number = ? ORDER BY id ASC`)
          .all(t.repo, t.issueNumber) as Record<string, unknown>[]
      ).map(mapMerge);
      const reverted =
        (t.phase.kind === "done" && t.phase.outcome === "reverted") || merges.some((m) => m.mainWatch.kind === "red");
      if (reverted) reverts++;
      const last = merges[merges.length - 1];
      if (!last) continue;
      const disputed = reverted || merges.some((m) => m.disagreed);
      const approvals = this.db
        .prepare(`SELECT vendor FROM reviews WHERE repo = ? AND issue_number = ? AND head_sha = ? AND verdict = 'approve'`)
        .all(t.repo, t.issueNumber, last.headSha) as Array<{ vendor: string }>;
      for (const { vendor } of approvals) {
        const v = (vendors[vendor] ??= { approvedMerges: 0, undisputed: 0 });
        v.approvedMerges++;
        if (!disputed) v.undisputed++;
      }
    }
    const fixes = landed.length;
    const vendorAgreement: OutcomeMetrics["vendorAgreement"] = {};
    for (const [vendor, v] of Object.entries(vendors)) {
      vendorAgreement[vendor] = { ...v, rate: ratio(v.undisputed, v.approvedMerges) };
    }
    return {
      mergedFixes: fixes,
      meteredUsdTotal: Number(meteredUsd.toFixed(4)),
      costUsdPerFix: fixes > 0 ? Number((meteredUsd / fixes).toFixed(4)) : null,
      attemptsPerFix: ratio(attempts, fixes),
      attemptMinutesPerFix: fixes > 0 ? Number((attemptMs / 60_000 / fixes).toFixed(2)) : null,
      reverts,
      revertsPerFix: ratio(reverts, fixes),
      reworkAttemptsTotal: rework,
      reworkAttemptsPerFix: ratio(rework, fixes),
      vendorAgreement,
    };
  }

  /** Issue numbers filed by any of these Scouts (the includeMetrics loop guard). */
  private issuesFiledByScouts(scouts: string[], repo: string | null): Set<number> {
    const out = new Set<number>();
    for (const scout of scouts) {
      const rows = this.db
        .prepare(`SELECT issue_number FROM scout_proposals WHERE scout_name = ? ${repo ? "AND repo = ?" : ""}`)
        .all(...(repo ? [scout, repo] : [scout])) as Array<{ issue_number: number }>;
      for (const r of rows) out.add(Number(r.issue_number));
    }
    return out;
  }

  /** Raw rows for failure clustering (the module that reads them keeps only fixed categories). Read-only. */
  listClusterRows(opts: { repo?: string | null; sinceMs: number; excludeScouts?: string[] }): {
    escalations: Array<{ ts: number; repo: string; issueNumber: number; code: string | null }>;
    openNeedsYou: Array<{ repo: string; issueNumber: number; code: string; updatedAt: number }>;
    branchByThread: Record<string, string>;
    attempts: Array<{ ts: number; repo: string; issueNumber: number; status: string; errorMessage: string | null; errorCategory: string | null }>;
    reviews: Array<{ ts: number; repo: string; issueNumber: number; vendor: string; verdict: string; findingsJson: string }>;
  } {
    const repo = opts.repo ?? null;
    const excluded = this.issuesFiledByScouts(opts.excludeScouts ?? [], repo);
    const keep = (issue: number | null) => issue === null || !excluded.has(issue);
    const scope = repo ? " AND repo = ?" : "";
    const args = (...a: SQLQueryBindings[]) => (repo ? [...a, repo] : a);
    const escalations = (
      this.db
        .prepare(`SELECT ts, repo, issue_number, payload_json FROM audit_log WHERE topic = 'escalation/raised' AND ts >= ?${scope}`)
        .all(...args(opts.sinceMs)) as Array<Record<string, unknown>>
    )
      .filter((r) => keep(r.issue_number === null ? null : Number(r.issue_number)))
      .map((r) => ({
        ts: Number(r.ts),
        repo: String(r.repo),
        issueNumber: Number(r.issue_number),
        code: ((JSON.parse(String(r.payload_json)) as { code?: unknown }).code as string | undefined) ?? null,
      }));
    const threads = repo ? this.listThreads(undefined, repo) : this.listAllThreads();
    return {
      escalations,
      openNeedsYou: threads
        .filter((t) => t.phase.kind === "needs_you" && t.updatedAt >= opts.sinceMs && keep(t.issueNumber))
        .map((t) => ({ repo: t.repo, issueNumber: t.issueNumber, code: (t.phase as { code: string }).code, updatedAt: t.updatedAt })),
      branchByThread: Object.fromEntries(threads.map((t) => [`${t.repo}#${t.issueNumber}`, t.branchName])),
      attempts: (
        this.db
          .prepare(`SELECT started_at, repo, issue_number, status, error_message, error_category FROM attempts WHERE started_at >= ?${scope}`)
          .all(...args(opts.sinceMs)) as Array<Record<string, unknown>>
      )
        .filter((r) => keep(Number(r.issue_number)))
        .map((r) => ({
          ts: Number(r.started_at),
          repo: String(r.repo),
          issueNumber: Number(r.issue_number),
          status: String(r.status),
          errorMessage: r.error_message === null ? null : String(r.error_message),
          errorCategory: r.error_category === null ? null : String(r.error_category),
        })),
      reviews: (
        this.db
          .prepare(`SELECT created_at, repo, issue_number, vendor, verdict, findings_json FROM reviews WHERE created_at >= ?${scope}`)
          .all(...args(opts.sinceMs)) as Array<Record<string, unknown>>
      )
        .filter((r) => keep(Number(r.issue_number)))
        .map((r) => ({
          ts: Number(r.created_at),
          repo: String(r.repo),
          issueNumber: Number(r.issue_number),
          vendor: String(r.vendor),
          verdict: String(r.verdict),
          findingsJson: String(r.findings_json),
        })),
    };
  }

  computeMetrics(
    opts: {
      repo?: string | null;
      sinceMs?: number;
      now?: number;
      /** Exclude Threads whose issue was filed by any of these Scouts (loop guard). */
      excludeScouts?: string[];
    } = {},
  ): {
    windowDays: number | null;
    threads: {
      total: number;
      byPhase: Record<string, number>;
      escalationsByCode: Record<string, number>;
      avgLeadTimeSec: number | null;
    };
    attempts: {
      total: number;
      succeeded: number;
      failed: number;
      aborted: number;
      successRate: number;
      p50DurationSec: number | null;
      p95DurationSec: number | null;
      /** Peak RSS (KB) of the agent's process tree per measured Attempt. */
      p50PeakRssKb: number | null;
      p95PeakRssKb: number | null;
      topErrors: Array<{ error: string; count: number }>;
      /** Failed attempts bucketed into fixed categories (never contains error text). */
      errorCategories: Record<string, number>;
      /** Per role (implement, revise, rebase): is the cheap tier good enough? `models` counts finished Attempts by provider/model. */
      byRole: Record<string, { attempts: number; succeeded: number; failed: number; aborted: number; costUsd: number; models: Record<string, number> }>;
    };
    reviews: {
      byVendor: Record<string, { approve: number; veto: number }>;
      outageEvents: number;
    };
    shadow: { total: number; agreed: number; disagreed: number; agreementRate: number };
    outcomes: OutcomeMetrics;
    /** Owner corrections counted in closed categories (see core/corrections.ts). */
    corrections: CorrectionCounts;
    activeCooldowns: Array<{ account: string; untilTs: number; reason: string }>;
  } {
    const now = opts.now ?? Date.now();
    const since = opts.sinceMs ?? 0;
    const repoFilter = opts.repo ?? null;

    const excludedIssues = this.issuesFiledByScouts(opts.excludeScouts ?? [], repoFilter);
    const excludedList = [...excludedIssues].join(",");
    const notExcluded = (col: string) => (excludedList ? ` AND (${col} IS NULL OR ${col} NOT IN (${excludedList}))` : "");

    const allThreads = (repoFilter ? this.listThreads(undefined, repoFilter) : this.listAllThreads()).filter(
      (t) => !excludedIssues.has(t.issueNumber),
    );
    const threads = since > 0 ? allThreads.filter((t) => t.createdAt >= since) : allThreads;

    const byPhase: Record<string, number> = {};
    const escalationsByCode: Record<string, number> = {};
    const leadTimesSec: number[] = [];

    for (const t of threads) {
      byPhase[t.phase.kind] = (byPhase[t.phase.kind] ?? 0) + 1;
      if (t.phase.kind === "needs_you") {
        escalationsByCode[t.phase.code] = (escalationsByCode[t.phase.code] ?? 0) + 1;
      }
      if (t.phase.kind === "shadow_ready" || (t.phase.kind === "done" && (t.phase.outcome === "merged" || t.phase.outcome === "owner_merged"))) {
        leadTimesSec.push(Math.max(0, (t.updatedAt - t.createdAt) / 1000));
      }
    }

    const attParams: SQLQueryBindings[] = [since];
    const attWhere =
      (repoFilter ? "WHERE started_at >= ? AND repo = ?" : "WHERE started_at >= ?") + notExcluded("issue_number");
    if (repoFilter) attParams.push(repoFilter);
    const attemptRows = this.db
      .prepare(`SELECT kind, cost_usd, provider, model, status, started_at, finished_at, error_message, error_category, peak_rss_kb FROM attempts ${attWhere}`)
      .all(...attParams) as Array<{
      kind: string;
      cost_usd: number;
      provider: string | null;
      model: string | null;
      status: string;
      started_at: number;
      finished_at: number | null;
      error_message: string | null;
      error_category: string | null;
      peak_rss_kb: number | null;
    }>;

    let succeeded = 0;
    let failed = 0;
    let aborted = 0;
    const durationsSec: number[] = [];
    const peakRssKb: number[] = attemptRows.flatMap((a) => (a.peak_rss_kb === null ? [] : [a.peak_rss_kb])).sort((x, y) => x - y);
    const errorCounts = new Map<string, number>();
    const errorCategories: Record<string, number> = {};
    const byRole: Record<string, { attempts: number; succeeded: number; failed: number; aborted: number; costUsd: number; models: Record<string, number> }> = {};

    for (const a of attemptRows) {
      const role = (byRole[a.kind] ??= { attempts: 0, succeeded: 0, failed: 0, aborted: 0, costUsd: 0, models: {} });
      role.attempts++;
      role.costUsd = Number((role.costUsd + a.cost_usd).toFixed(4));
      if (a.status === "succeeded" || a.status === "failed" || a.status === "aborted") role[a.status]++;
      if (a.provider) {
        const key = `${a.provider}/${a.model ?? "default"}`;
        role.models[key] = (role.models[key] ?? 0) + 1;
      }
      if (a.status === "succeeded") succeeded++;
      else if (a.status === "failed") failed++;
      else if (a.status === "aborted") aborted++;
      if (a.finished_at !== null && a.finished_at >= a.started_at) {
        durationsSec.push((a.finished_at - a.started_at) / 1000);
      }
      if (a.status === "failed" && a.error_message) {
        const key = a.error_message.slice(0, 120);
        errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
        const cat = a.error_category ?? "other"; // rows from before the category was recorded
        errorCategories[cat] = (errorCategories[cat] ?? 0) + 1;
      }
    }

    durationsSec.sort((x, y) => x - y);
    const percentile = (arr: number[], p: number): number | null => {
      if (arr.length === 0) return null;
      const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(arr.length * p) - 1));
      return Number(arr[idx]!.toFixed(1));
    };

    const revParams: SQLQueryBindings[] = [since];
    const revWhere =
      (repoFilter ? "WHERE created_at >= ? AND repo = ?" : "WHERE created_at >= ?") + notExcluded("issue_number");
    if (repoFilter) revParams.push(repoFilter);
    const reviewRows = this.db
      .prepare(`SELECT vendor, verdict FROM reviews ${revWhere}`)
      .all(...revParams) as Array<{ vendor: string; verdict: string }>;

    const byVendor: Record<string, { approve: number; veto: number }> = {};
    for (const r of reviewRows) {
      const bucket = byVendor[r.vendor] ?? { approve: 0, veto: 0 };
      if (r.verdict === "approve") bucket.approve++;
      else bucket.veto++;
      byVendor[r.vendor] = bucket;
    }

    const outParams: SQLQueryBindings[] = ["review/outage_started", since];
    const outWhere =
      (repoFilter ? "WHERE topic = ? AND ts >= ? AND repo = ?" : "WHERE topic = ? AND ts >= ?") + notExcluded("issue_number");
    if (repoFilter) outParams.push(repoFilter);
    const outageRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM audit_log ${outWhere}`)
      .get(...outParams) as { cnt: number };

    const topErrors = [...errorCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([error, count]) => ({ error, count }));

    const finished = succeeded + failed + aborted;
    return {
      windowDays: since > 0 ? Math.round((now - since) / 86_400_000) : null,
      threads: {
        total: threads.length,
        byPhase,
        escalationsByCode,
        avgLeadTimeSec:
          leadTimesSec.length > 0
            ? Number((leadTimesSec.reduce((a, b) => a + b, 0) / leadTimesSec.length).toFixed(1))
            : null,
      },
      attempts: {
        total: attemptRows.length,
        succeeded,
        failed,
        aborted,
        successRate: finished > 0 ? Number((succeeded / finished).toFixed(3)) : 1,
        p50DurationSec: percentile(durationsSec, 0.5),
        p95DurationSec: percentile(durationsSec, 0.95),
        p50PeakRssKb: percentile(peakRssKb, 0.5),
        p95PeakRssKb: percentile(peakRssKb, 0.95),
        topErrors,
        errorCategories,
        byRole,
      },
      reviews: {
        byVendor,
        outageEvents: Number(outageRow.cnt),
      },
      shadow: this.getShadowStats(repoFilter, since),
      outcomes: this.computeOutcomeMetrics(threads),
      corrections: this.computeCorrections({ repo: repoFilter, sinceMs: since, now, excludedIssues }),
      activeCooldowns: this.listActiveCooldowns(now),
    };
  }

  /**
   * Counts owner corrections from structured Ledger data only (statuses, verdicts, enums, severities and path segments).
   * `repo: null` covers every repo. Threads/events are windowed by their last change / timestamp.
   */
  computeCorrections(opts: { repo?: string | null; sinceMs?: number; now?: number; excludedIssues?: ReadonlySet<number> } = {}): CorrectionCounts {
    const since = opts.sinceMs ?? 0;
    const now = opts.now ?? Date.now();
    const repo = opts.repo ?? null;
    const skip = opts.excludedIssues ?? new Set<number>();
    const repoClause = repo ? " AND repo = ?" : "";
    const rp = repo ? [repo] : [];

    // Vetoes overruled: an owner-merged Thread whose most recent review round (by head SHA) contained a veto.
    let vetoOverruled = 0;
    const threads = (repo ? this.listThreads(undefined, repo) : this.listAllThreads()).filter((t) => !skip.has(t.issueNumber));
    const latestHead = this.db.prepare(`SELECT head_sha FROM reviews WHERE repo = ? AND issue_number = ? ORDER BY created_at DESC, id DESC LIMIT 1`);
    const vetoAt = this.db.prepare(`SELECT 1 FROM reviews WHERE repo = ? AND issue_number = ? AND head_sha = ? AND verdict != 'approve' LIMIT 1`);
    for (const t of threads) {
      if (t.phase.kind !== "done" || t.phase.outcome !== "owner_merged" || t.updatedAt < since) continue;
      const head = latestHead.get(t.repo, t.issueNumber) as { head_sha: string } | undefined;
      if (head && vetoAt.get(t.repo, t.issueNumber, head.head_sha)) vetoOverruled++;
    }

    const merges = (
      this.db.prepare(`SELECT * FROM merges WHERE created_at >= ?${repoClause}`).all(since, ...rp) as Record<string, unknown>[]
    ).map(mapMerge).filter((m) => !skip.has(m.issueNumber));
    const disagreements = merges.filter((m) => m.disagreed).length;
    const reverts = new Set(merges.filter((m) => m.mainWatch.kind === "red").map((m) => `${m.repo}#${m.issueNumber}`)).size;

    const ownerRetriesByCode: Record<string, number> = {};
    for (const r of this.db
      .prepare(`SELECT issue_number, payload_json FROM audit_log WHERE topic = 'thread/owner_retry' AND actor = 'owner' AND ts >= ?${repoClause}`)
      .all(since, ...rp) as Array<{ issue_number: number | null; payload_json: string }>) {
      if (r.issue_number !== null && skip.has(r.issue_number)) continue;
      const raw = tryParseJson(r.payload_json);
      if (!raw.ok || typeof raw.value !== "object" || raw.value === null) continue;
      const code = (raw.value as { code?: unknown }).code;
      if (typeof code === "string" && (EscalationCodeSchema.options as readonly string[]).includes(code)) {
        ownerRetriesByCode[code] = (ownerRetriesByCode[code] ?? 0) + 1;
      }
    }

    const factoryRetries: Record<string, number> = {};
    for (const repoName of repo ? [repo] : [...new Set(threads.map((t) => t.repo))]) {
      for (const r of this.factoryRetryOutcomes({ repo: repoName })) {
        if (r.at < since || skip.has(r.issueNumber) || r.outcome === "success" || r.outcome === "pending") continue;
        const key = `${r.code}:${r.outcome}`;
        factoryRetries[key] = (factoryRetries[key] ?? 0) + 1;
      }
    }

    const findings: Record<string, number> = {};
    for (const r of this.db
      .prepare(`SELECT issue_number, findings_json FROM reviews WHERE verdict != 'approve' AND created_at >= ?${repoClause}`)
      .all(since, ...rp) as Array<{ issue_number: number; findings_json: string }>) {
      if (skip.has(r.issue_number)) continue;
      const raw = tryParseJson(r.findings_json);
      if (!raw.ok || !Array.isArray(raw.value)) continue;
      for (const f of raw.value as ReviewFinding[]) {
        const key = f && typeof f === "object" ? findingCategory(f) : null;
        if (key) findings[key] = (findings[key] ?? 0) + 1;
      }
    }

    return {
      windowDays: since > 0 ? Math.max(1, Math.round((now - since) / 86_400_000)) : null,
      vetoOverruled,
      disagreements,
      ownerRetriesByCode,
      reverts,
      findings,
      factoryRetries,
    };
  }
}

function mapThread(r: Record<string, unknown>): ThreadRecord {
  const phase = PhaseSchema.parse(JSON.parse(String(r.phase_json)));
  return {
    issueNumber: Number(r.issue_number),
    repo: String(r.repo),
    title: String(r.title),
    themeLabel: r.theme_label === null ? null : String(r.theme_label),
    bodySha256: String(r.body_sha256),
    phase,
    state: phase.kind,
    version: Number(r.version),
    mode: String(r.mode) as Mode,
    branchName: String(r.branch_name),
    lastSummary: r.last_summary === null ? null : String(r.last_summary),
    implementCount: Number(r.implement_count),
    revisionCount: Number(r.revision_count),
    rebaseCount: Number(r.rebase_count),
    implementerVendors: r.implementer_vendors_json
      ? (JSON.parse(String(r.implementer_vendors_json)) as ReviewerVendor[])
      : [],
    ownerReply: r.owner_reply === null || r.owner_reply === undefined ? null : String(r.owner_reply),
    retryGrants: Number(r.retry_grants ?? 0),
    factoryRetries: Number(r.factory_retries ?? 0),
    factoryGuidance: r.factory_guidance === null || r.factory_guidance === undefined ? null : String(r.factory_guidance),
    factoryTriage: r.factory_triage === "pending" || r.factory_triage === "done" ? r.factory_triage : null,
    workflowSha256: r.workflow_sha256 === null || r.workflow_sha256 === undefined ? null : String(r.workflow_sha256),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapAttempt(r: Record<string, unknown>): AttemptRecord {
  return {
    id: Number(r.id),
    repo: String(r.repo),
    issueNumber: Number(r.issue_number),
    kind: String(r.kind) as AttemptKind,
    status: String(r.status) as AttemptRecord["status"],
    headSha: r.head_sha === null ? null : String(r.head_sha),
    costUsd: Number(r.cost_usd),
    transcriptPath: r.transcript_path === null ? null : String(r.transcript_path),
    errorMessage: r.error_message === null ? null : String(r.error_message),
    errorCategory: r.error_category === null || r.error_category === undefined ? null : (String(r.error_category) as AttemptErrorCategory),
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    provider: r.provider === null || r.provider === undefined ? null : String(r.provider),
    model: r.model === null || r.model === undefined ? null : String(r.model),
    accountId: r.account_id === null || r.account_id === undefined ? null : String(r.account_id),
    compute: r.compute === null || r.compute === undefined ? null : String(r.compute),
    promptSha256: r.prompt_sha256 === null || r.prompt_sha256 === undefined ? null : String(r.prompt_sha256),
    workflowSha256: r.workflow_sha256 === null || r.workflow_sha256 === undefined ? null : String(r.workflow_sha256),
    durationMs: r.duration_ms === null || r.duration_ms === undefined ? null : Number(r.duration_ms),
    peakRssKb: r.peak_rss_kb === null || r.peak_rss_kb === undefined ? null : Number(r.peak_rss_kb),
  };
}

function mapReview(r: Record<string, unknown>): ReviewRecord {
  return {
    id: Number(r.id),
    repo: String(r.repo),
    issueNumber: Number(r.issue_number),
    headSha: String(r.head_sha),
    vendor: String(r.vendor) as ReviewerVendor,
    verdict: String(r.verdict) as ReviewVerdict,
    findingsJson: String(r.findings_json),
    costUsd: Number(r.cost_usd),
    createdAt: Number(r.created_at),
    provider: r.provider === null || r.provider === undefined ? null : String(r.provider),
    model: r.model === null || r.model === undefined ? null : String(r.model),
    accountId: r.account_id === null || r.account_id === undefined ? null : String(r.account_id),
    promptSha256: r.prompt_sha256 === null || r.prompt_sha256 === undefined ? null : String(r.prompt_sha256),
    rubricSha256: r.rubric_sha256 === null || r.rubric_sha256 === undefined ? null : String(r.rubric_sha256),
    workflowSha256: r.workflow_sha256 === null || r.workflow_sha256 === undefined ? null : String(r.workflow_sha256),
  };
}

function mapMerge(r: Record<string, unknown>): MergeRecord {
  return {
    id: Number(r.id),
    repo: String(r.repo),
    issueNumber: Number(r.issue_number),
    prNumber: Number(r.pr_number),
    headSha: String(r.head_sha),
    squashSha: r.squash_sha === null ? null : String(r.squash_sha),
    shadowOnly: Number(r.shadow_only) === 1,
    disagreed: Number(r.disagreed) === 1,
    dayKey: String(r.day_key),
    mainWatch: MainWatchSchema.parse(JSON.parse(String(r.main_watch_json))),
    mainRequired: JSON.parse(String(r.main_required_json ?? "[]")) as string[],
    createdAt: Number(r.created_at),
  };
}

function mapCommand(r: Record<string, unknown>): DaemonCommandRecord {
  return {
    id: Number(r.id),
    repo: String(r.repo),
    issueNumber: Number(r.issue_number),
    kind: String(r.kind) as "handoff",
    state: CommandStateSchema.parse(JSON.parse(String(r.state_json))),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** An outbox table from before explicit states gains `state` and `next_attempt_at`; existing rows stay deliverable. */
function migrateOutbox(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  if (cols.length === 0 || cols.some((c) => c.name === "state")) return;
  db.exec("ALTER TABLE outbox ADD COLUMN state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'retrying', 'dead_letter'))");
  db.exec("ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0");
}

function outboxRecord(r: Record<string, unknown>): OutboxRecord {
  const raw = tryParseJson(String(r.effect_json));
  const res = raw.ok ? OutboxEffectSchema.safeParse(raw.value) : null;
  const parsed: OutboxEffect | null = res?.success ? res.data : null;
  return {
    id: Number(r.id),
    repo: String(r.repo),
    effect: parsed,
    state: r.state as OutboxRecord["state"],
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    lastError: r.last_error === null ? null : String(r.last_error),
    createdAt: Number(r.created_at),
  };
}

export interface PocRow {
  repo: string;
  issueNumber: number;
  ref: string;
  builds: number;
  autoQueued: boolean;
  costUsd: number;
  diffStat: string | null;
  state: PocState;
}

interface PocDbRow {
  repo: string;
  issue_number: number;
  ref: string;
  builds: number;
  auto_queued: number;
  cost_usd: number;
  diff_stat: string | null;
  state_json: string;
}

function toPocRow(r: PocDbRow): PocRow {
  return { repo: r.repo, issueNumber: r.issue_number, ref: r.ref, builds: r.builds, autoQueued: r.auto_queued === 1, costUsd: r.cost_usd, diffStat: r.diff_stat, state: PocStateSchema.parse(JSON.parse(r.state_json)) };
}
