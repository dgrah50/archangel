import { describeEscalation } from "../core/escalations.js";
import { workClassOfBranch } from "../core/work-class.js";
import { categorizeAttemptError } from "../core/metrics-block.js";
import type { DigestInput } from "../core/digest.js";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  MainWatchSchema,
  PhaseSchema,
  type AttemptKind,
  type MainWatch,
  type Mode,
  type OutboxEffect,
  type Phase,
  type PhaseKind,
} from "../core/thread-machine.js";
import {
  LEDGER_SCHEMA_SQL,
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
  type ThreadRecord,
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
export interface StageMetrics {
  windowDays: number;
  intake: { queued: number; oldestQueuedAgeSec: number | null; rejections: Record<string, number> };
  scouts: Record<
    string,
    { runs: number; secretsBlocked: number; filed: number; becameThread: number; merged: number; reverted: number }
  >;
  promotion: { autoPromotionsLast24h: number; autoPromotionsInWindow: number };
  workClass: Record<"bugfix" | "feature", { threads: number; merged: number; attemptsPerMerge: number | null }>;
  gate: { attempts: { total: number; succeeded: number; failed: number }; escalations: Record<string, number> };
  review: { byVendor: Record<string, { approve: number; veto: number }>; outages: number };
  landing: { autoMerged: number; ownerMerged: number; reverts: number; disagreements: number; autonomyCapHits: number };
  needsYou: { byDecisionClass: Record<string, number> };
  /** Threads split by the workflow file version stamped on them ("none" for Threads from before stamping). */
  byWorkflowSha: Record<string, { threads: number; merged: number; reverted: number }>;
}

/** Consecutive unmerged auto-promoted Threads of one Scout version that revoke its auto-promotion. */
export const SCOUT_WASTE_STREAK = 3;

export class Ledger {
  private readonly db: Database.Database;
  private readonly timeZone: string;
  readonly repo: string;

  constructor(
    dbPath: string,
    opts: { repo?: string; timeZone?: string; readonly?: boolean } = {},
  ) {
    if (!opts.readonly && dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath, { readonly: opts.readonly ?? false });
    this.repo = opts.repo ?? "default";
    this.timeZone = opts.timeZone ?? "America/New_York";
    if (!opts.readonly) {
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
      const addCols = (table: string, cols: string[]) => {
        const have = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        for (const c of cols) if (!have.includes(c)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} TEXT`);
      };
      addCols("attempts", ["provider", "model", "prompt_sha256", "workflow_sha256"]);
      addCols("reviews", ["provider", "model", "prompt_sha256", "rubric_sha256", "workflow_sha256"]);
      const mergeCols = this.db.prepare("PRAGMA table_info(merges)").all() as Array<{ name: string }>;
      if (!mergeCols.some((c) => c.name === "main_required_json")) {
        this.db.exec("ALTER TABLE merges ADD COLUMN main_required_json TEXT NOT NULL DEFAULT '[]'");
      }
      const pitchCols = this.db.prepare("PRAGMA table_info(pitches)").all() as Array<{ name: string }>;
      if (!pitchCols.some((c) => c.name === "decline_reason")) this.db.exec("ALTER TABLE pitches ADD COLUMN decline_reason TEXT");
      if (!pitchCols.some((c) => c.name === "pitch_json")) this.db.exec("ALTER TABLE pitches ADD COLUMN pitch_json TEXT NOT NULL DEFAULT ''");
      const spCols = this.db.prepare("PRAGMA table_info(scout_proposals)").all() as Array<{ name: string }>;
      if (!spCols.some((c) => c.name === "file_sha256")) {
        this.db.exec("ALTER TABLE scout_proposals ADD COLUMN file_sha256 TEXT");
      }
      if (!spCols.some((c) => c.name === "auto_promoted")) {
        this.db.exec("ALTER TABLE scout_proposals ADD COLUMN auto_promoted INTEGER NOT NULL DEFAULT 0");
      }
    } else {
      this.db.pragma("busy_timeout = 5000");
    }
  }

  /** Stores the owner's reply to the latest escalation (capped) so the next Attempt sees it. */
  setOwnerReply(issueNumber: number, reply: string | null, now = Date.now()): void {
    const text = reply && reply.trim() ? reply.trim().slice(0, OWNER_REPLY_MAX_CHARS) : null;
    this.db
      .prepare("UPDATE threads SET owner_reply = ?, updated_at = ? WHERE repo = ? AND issue_number = ?")
      .run(text, now, this.repo, issueNumber);
    this.appendAudit("thread/owner_reply", issueNumber, "owner", { chars: text?.length ?? 0 }, now);
  }

  /** An owner retry grants the Thread one more implement and one more revision Attempt. */
  grantRetryBudget(issueNumber: number, now = Date.now()): void {
    this.db
      .prepare("UPDATE threads SET retry_grants = retry_grants + 1, updated_at = ? WHERE repo = ? AND issue_number = ?")
      .run(now, this.repo, issueNumber);
  }

  forRepo(repo: string): Ledger {
    const view = Object.create(Ledger.prototype) as Ledger;
    Object.assign(view, { db: this.db, timeZone: this.timeZone, repo });
    return view;
  }

  close(): void {
    this.db.close();
  }

  // --- Single Daemon Lock (Opus Step 4 / R9) ---

  acquireDaemonLock(ownerId: string, staleMs: number, now = Date.now()): boolean {
    const tx = this.db.transaction(() => {
      const existing = this.getSystemState("daemon_lock");
      if (existing) {
        try {
          const parsed = JSON.parse(existing) as { ownerId: string; heartbeatAt: number };
          if (parsed.ownerId !== ownerId && now - parsed.heartbeatAt < staleMs) {
            return false;
          }
        } catch {
          // Corrupted lock row: overwrite cleanly.
        }
      }
      this.setSystemState("daemon_lock", JSON.stringify({ ownerId, pid: process.pid, heartbeatAt: now }), now);
      return true;
    });
    return tx();
  }

  heartbeatDaemonLock(ownerId: string, now = Date.now()): void {
    const existing = this.getSystemState("daemon_lock");
    if (!existing) return;
    try {
      const parsed = JSON.parse(existing) as { ownerId: string };
      if (parsed.ownerId === ownerId) {
        this.setSystemState("daemon_lock", JSON.stringify({ ownerId, pid: process.pid, heartbeatAt: now }), now);
      }
    } catch {
      // Ignore
    }
  }

  releaseDaemonLock(ownerId: string): void {
    const existing = this.getSystemState("daemon_lock");
    if (!existing) return;
    try {
      const parsed = JSON.parse(existing) as { ownerId: string };
      if (parsed.ownerId === ownerId) {
        this.db.prepare(`DELETE FROM system_state WHERE key = 'daemon_lock'`).run();
      }
    } catch {
      // Ignore
    }
  }

  isDaemonActive(staleMs: number, now = Date.now()): boolean {
    const existing = this.getSystemState("daemon_lock");
    if (!existing) return false;
    try {
      const parsed = JSON.parse(existing) as { heartbeatAt: number };
      return now - parsed.heartbeatAt < staleMs;
    } catch {
      return false;
    }
  }

  // --- Threads & Compare-And-Set Transitions ---

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
          repo, issue_number, title, theme_label, body_sha256, phase_json, version, mode, branch_name, workflow_sha256, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
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
    const params: unknown[] = [];
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
    nextPhase: Phase,
    opts: {
      nextMode?: Mode;
      effects?: OutboxEffect[];
      bodySha256?: string;
      lastSummary?: string | null;
      incImplement?: boolean;
      incRevision?: boolean;
      incRebase?: boolean;
      auditTopic?: string;
      auditPayload?: unknown;
      now?: number;
      repo?: string;
    } = {},
  ): ThreadRecord | null {
    const repo = opts.repo ?? this.repo;
    const now = opts.now ?? Date.now();
    const validated = PhaseSchema.parse(nextPhase);

    const tx = this.db.transaction((): ThreadRecord | null => {
      const sets: string[] = ["phase_json = ?", "version = version + 1", "updated_at = ?"];
      const vals: unknown[] = [JSON.stringify(validated), now];

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

      if (opts.auditTopic) {
        this.appendAudit(opts.auditTopic, issueNumber, "archangel", opts.auditPayload ?? { next: validated.kind }, now, repo);
      }

      return this.getThread(issueNumber, repo);
    });

    return tx();
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
            `UPDATE attempts SET status = 'failed', error_message = 'stale working run swept on startup', finished_at = ?
             WHERE repo = ? AND issue_number = ? AND status = 'running'`,
          )
          .run(now, repo, t.issueNumber);

        const nextPhase: Phase =
          t.phase.resumeTo.kind === "awaiting_gate"
            ? {
                kind: "awaiting_gate",
                prNumber: t.phase.resumeTo.prNumber,
                headSha: t.phase.resumeTo.headSha,
                baseSha: t.phase.resumeTo.baseSha,
                since: now,
                nudgedAt: null,
              }
            : { kind: "queued" };

        const updated = this.transition(t.issueNumber, t.version, nextPhase, {
          auditTopic: "thread/stale_swept",
          auditPayload: { previousAttempt: t.phase.attempt, next: nextPhase.kind },
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
    tx();
    return recovered;
  }

  // --- Durable Outbox (Opus L3) ---

  /** Least-failed first, so rows that keep failing cannot starve newer effects out of the batch limit. */
  listOutbox(repo = this.repo, limit = 50): OutboxRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM outbox WHERE repo = ? ORDER BY attempts ASC, id ASC LIMIT ?`)
      .all(repo, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      repo: String(r.repo),
      effect: JSON.parse(String(r.effect_json)) as OutboxEffect,
      attempts: Number(r.attempts),
      lastError: r.last_error === null ? null : String(r.last_error),
      createdAt: Number(r.created_at),
    }));
  }

  /** True while an `add_label` for this label on this issue is still queued (not yet delivered to GitHub). */
  hasPendingLabelAdd(issueNumber: number, label: string, repo = this.repo): boolean {
    return this.listOutbox(repo, 1000).some(
      (o) => o.effect.kind === "add_label" && o.effect.issueNumber === issueNumber && o.effect.label === label,
    );
  }

  completeOutbox(id: number): void {
    this.db.prepare(`DELETE FROM outbox WHERE id = ?`).run(id);
  }

  failOutbox(id: number, error: string): void {
    this.db
      .prepare(`UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`)
      .run(error, id);
  }

  // --- Daemon Commands Queue (Handoff across CLI <-> Daemon, Opus Step 6 / R5) ---

  enqueueCommand(issueNumber: number, kind: "handoff", now = Date.now(), repo = this.repo): number {
    const info = this.db
      .prepare(
        `INSERT INTO daemon_commands (repo, issue_number, kind, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .run(repo, issueNumber, kind, now, now);
    return Number(info.lastInsertRowid);
  }

  listPendingCommands(repo = this.repo): DaemonCommandRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM daemon_commands WHERE repo = ? AND status = 'pending' ORDER BY id ASC`)
      .all(repo) as Record<string, unknown>[];
    return rows.map(mapCommand);
  }

  getCommand(id: number): DaemonCommandRecord | null {
    const row = this.db.prepare(`SELECT * FROM daemon_commands WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapCommand(row) : null;
  }

  completeCommand(id: number, result: unknown, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE daemon_commands SET status = 'completed', result_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(result), now, id);
  }

  failCommand(id: number, errorMessage: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE daemon_commands SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`,
      )
      .run(errorMessage, now, id);
  }

  // --- Attempts ---

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
    p: { provider?: string | null; model?: string | null; promptSha256?: string | null; workflowSha256?: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE attempts SET provider = COALESCE(?, provider), model = COALESCE(?, model),
           prompt_sha256 = COALESCE(?, prompt_sha256), workflow_sha256 = COALESCE(?, workflow_sha256) WHERE id = ?`,
      )
      .run(p.provider ?? null, p.model ?? null, p.promptSha256 ?? null, p.workflowSha256 ?? null, attemptId);
  }

  finishAttempt(
    attemptId: number,
    result: {
      status: "succeeded" | "failed" | "aborted";
      headSha?: string | null;
      costUsd?: number;
      reservedUsd?: number;
      transcriptPath?: string | null;
      errorMessage?: string | null;
    },
    now = Date.now(),
  ): AttemptRecord {
    const cost = Math.max(0, result.costUsd ?? 0);
    this.db
      .prepare(
        `UPDATE attempts
         SET status = ?, head_sha = ?, cost_usd = ?, transcript_path = ?, error_message = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        result.status,
        result.headSha ?? null,
        cost,
        result.transcriptPath ?? null,
        result.errorMessage ?? null,
        now,
        attemptId,
      );
    if (result.reservedUsd !== undefined) {
      this.settleBudget(result.reservedUsd, cost, now);
    } else if (cost > 0) {
      this.addSpend(cost, now);
    }
    const attempt = this.getAttempt(attemptId)!;
    this.appendAudit(
      "attempt/finished",
      attempt.issueNumber,
      "archangel",
      {
        attemptId,
        status: result.status,
        headSha: result.headSha ?? null,
        costUsd: cost,
        error: result.errorMessage ?? null,
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

  // --- Recorded Pushed SHAs (INSERT OR IGNORE preserves broker provenance — Opus R14) ---

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

  // --- Reviews ---

  recordReview(input: {
    issueNumber: number;
    headSha: string;
    vendor: ReviewerVendor;
    verdict: ReviewVerdict;
    findings: ReviewFinding[];
    costUsd: number;
    provider?: string | null;
    model?: string | null;
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
                              provider, model, prompt_sha256, rubric_sha256, workflow_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, issue_number, head_sha, vendor) DO UPDATE SET
           verdict = excluded.verdict,
           findings_json = excluded.findings_json,
           cost_usd = excluded.cost_usd,
           created_at = excluded.created_at,
           provider = excluded.provider,
           model = excluded.model,
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

  // --- Merges & Shadow Mode ---

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

  // --- Hard Daily Spend Cap with Atomic Budget Reservation (Codex #10 & Opus R8) ---

  getSpendBreakdown(now = Date.now()): { spentUsd: number; reservedUsd: number; committedUsd: number } {
    const dayKey = formatDayKey(now, this.timeZone);
    const row = this.db
      .prepare(`SELECT usd, reserved_usd FROM daily_spend WHERE day_key = ?`)
      .get(dayKey) as { usd: number; reserved_usd: number } | undefined;
    const spentUsd = row?.usd ?? 0;
    const reservedUsd = row?.reserved_usd ?? 0;
    return { spentUsd, reservedUsd, committedUsd: spentUsd + reservedUsd };
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

  // --- Per-Repo Circuit Breaker ---

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

  // --- Append-Only Audit Log ---

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

  listAudit(
    opts: { repo?: string; topicPrefix?: string; issueNumber?: number; limit?: number } = {},
  ): AuditLogEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
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

  // ---- Provider Rate-Limit Cooldowns (Continuity Optimization) ----

  setProviderCooldown(provider: string, durationMs: number, reason: string, now = Date.now()): void {
    const untilTs = now + Math.max(1000, durationMs);
    this.db
      .prepare(
        `INSERT INTO provider_cooldowns(provider, until_ts, reason, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET until_ts = excluded.until_ts, reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .run(provider, untilTs, reason.slice(0, 300), now);
  }

  getProviderCooldown(provider: string, now = Date.now()): { untilTs: number; reason: string } | null {
    const row = this.db
      .prepare("SELECT until_ts, reason FROM provider_cooldowns WHERE provider = ? AND until_ts > ?")
      .get(provider, now) as { until_ts: number; reason: string } | undefined;
    return row ? { untilTs: Number(row.until_ts), reason: String(row.reason) } : null;
  }

  listActiveCooldowns(now = Date.now()): Array<{ provider: string; untilTs: number; reason: string }> {
    try {
      const rows = this.db
        .prepare("SELECT provider, until_ts, reason FROM provider_cooldowns WHERE until_ts > ? ORDER BY provider")
        .all(now) as Array<{ provider: string; until_ts: number; reason: string }>;
      return rows.map((r) => ({
        provider: String(r.provider),
        untilTs: Number(r.until_ts),
        reason: String(r.reason),
      }));
    } catch {
      return [];
    }
  }

  // ---- Scout Proposals & Atomic Daily Run Caps (V2.0 / Opus H2, M3, M5) ----

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
    try {
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
    } catch {
      return null;
    }
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

  hasScoutTitleFingerprint(titleFp: string, repo = this.repo): boolean {
    try {
      const row = this.db
        .prepare(`SELECT 1 FROM scout_proposals WHERE repo = ? AND title_fp = ? LIMIT 1`)
        .get(repo, titleFp);
      return Boolean(row);
    } catch {
      return false;
    }
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
        try {
          const p = JSON.parse(r.payload_json) as { dayKey?: string };
          if (p.dayKey === dayKey) {
            todayCount++;
            if (r.actor === scoutName) ranThisScoutToday = true;
          }
        } catch {
          // ignore malformed payload
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

  // ---- Pitches (V5): owner-decided proposals from pitch Scouts; separate from bug proposals ----

  recordPitch(input: { issueNumber: number; scoutName: string; trustHash: string; title: string; titleFp: string; contentSha256: string; pitchJson?: string; now?: number; repo?: string }): void {
    const now = input.now ?? Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO pitches (repo, issue_number, scout_name, trust_hash, title, title_fp, content_sha256, filed_at, status_at, pitch_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.repo ?? this.repo, input.issueNumber, input.scoutName, input.trustHash, input.title, input.titleFp, input.contentSha256, now, now, input.pitchJson ?? "");
  }

  /** Pitches whose issue is no longer open (closed by the owner or expired) become `declined`. `promoted` is set only by the owner's promote command. */
  syncPitchStatuses(openIssueNumbers: readonly number[], now = Date.now(), repo = this.repo): Array<{ issueNumber: number; filedAt: number }> {
    const open = new Set(openIssueNumbers);
    const declined: Array<{ issueNumber: number; filedAt: number }> = [];
    for (const row of this.db.prepare(`SELECT issue_number, filed_at FROM pitches WHERE repo = ? AND status = 'open'`).all(repo) as Array<{ issue_number: number; filed_at: number }>) {
      if (!open.has(row.issue_number)) {
        this.db.prepare(`UPDATE pitches SET status = 'declined', status_at = ? WHERE repo = ? AND issue_number = ?`).run(now, repo, row.issue_number);
        declined.push({ issueNumber: row.issue_number, filedAt: row.filed_at });
      }
    }
    return declined;
  }

  setPitchDeclineReason(issueNumber: number, reason: string, repo = this.repo): void {
    this.db.prepare(`UPDATE pitches SET decline_reason = ? WHERE repo = ? AND issue_number = ?`).run(reason, repo, issueNumber);
  }

  getPitch(issueNumber: number, repo = this.repo): { issueNumber: number; status: "open" | "declined" | "promoted"; contentSha256: string; pitchJson: string } | null {
    const r = this.db
      .prepare(`SELECT issue_number, status, content_sha256, pitch_json FROM pitches WHERE repo = ? AND issue_number = ?`)
      .get(repo, issueNumber) as { issue_number: number; status: "open" | "declined" | "promoted"; content_sha256: string; pitch_json: string } | undefined;
    return r ? { issueNumber: r.issue_number, status: r.status, contentSha256: r.content_sha256, pitchJson: r.pitch_json } : null;
  }

  /** Only `archangel pitch promote` (the owner's `gh`) sets this. */
  markPitchPromoted(issueNumber: number, now = Date.now(), repo = this.repo): void {
    this.db.prepare(`UPDATE pitches SET status = 'promoted', status_at = ? WHERE repo = ? AND issue_number = ?`).run(now, repo, issueNumber);
  }

  countOpenPitches(repo = this.repo): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM pitches WHERE repo = ? AND status = 'open'`).get(repo) as { n: number }).n;
  }

  /** Titles of pitches that are open or were decided in the last `days` days (for the prompt and the duplicate check). */
  recentPitchTitles(days: number, now = Date.now(), repo = this.repo): Array<{ title: string; titleFp: string; declineReason: string | null }> {
    return (
      this.db
        .prepare(`SELECT title, title_fp, decline_reason FROM pitches WHERE repo = ? AND (status = 'open' OR status_at >= ?) ORDER BY filed_at DESC`)
        .all(repo, now - days * 86_400_000) as Array<{ title: string; title_fp: string; decline_reason: string | null }>
    ).map((r) => ({ title: r.title, titleFp: r.title_fp, declineReason: r.decline_reason }));
  }

  /** A pitch Scout pauses for one exact `trustHash` after `n` consecutive pitches that were not promoted. Editing the Scout (a new hash) resumes it. */
  isPitchScoutPaused(scoutName: string, trustHash: string, n: number, repo = this.repo): boolean {
    const rows = this.db
      .prepare(`SELECT status FROM pitches WHERE repo = ? AND scout_name = ? AND trust_hash = ? ORDER BY filed_at DESC, issue_number DESC LIMIT ?`)
      .all(repo, scoutName, trustHash, n) as Array<{ status: string }>;
    return rows.length === n && rows.every((r) => r.status !== "promoted");
  }

  /** Did this Scout start a run at or after `sinceMs`? (weekly schedule) */
  scoutRanSince(scoutName: string, sinceMs: number, repo = this.repo): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM audit_log WHERE repo = ? AND topic = 'scout/run' AND actor = ? AND ts >= ? LIMIT 1`)
        .get(repo, scoutName, sinceMs),
    );
  }

  // ---- Daily digest ----

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
      } catch {
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
    };
  }

  /** Cached `EffectiveWorkflow` JSON per repo, as written by each Reconciler tick (`workflow:<repo>`). */
  /** `workflow` is null when the stored text is not JSON (the caller treats that as unreadable, never as a crash). */
  listCachedWorkflows(): Array<{ repo: string; workflow: unknown }> {
    const rows = this.db.prepare(`SELECT key, value FROM system_state WHERE key LIKE 'workflow:%'`).all() as Array<{ key: string; value: string }>;
    return rows.map((r) => {
      let workflow: unknown = null;
      try {
        workflow = JSON.parse(r.value);
      } catch {
        // corrupt cache row: reported as unreadable by the dashboard
      }
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
    const count = (sql: string, ...params: unknown[]) => (this.db.prepare(sql).get(...params) as { n: number }).n;
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
    };
    const attemptsOf = this.db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE repo = ? AND issue_number = ?`);
    const attemptTotals = { bugfix: 0, feature: 0 };
    for (const t of threads) {
      const cls = workClassOfBranch(t.branchName);
      workClass[cls].threads++;
      if (landed(t)) {
        workClass[cls].merged++;
        attemptTotals[cls] += (attemptsOf.get(repo, t.issueNumber) as { n: number }).n;
      }
    }
    for (const cls of ["bugfix", "feature"] as const) {
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
    };
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

  // ---- Operational Metrics & Self-Improvement Telemetry ----

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
      topErrors: Array<{ error: string; count: number }>;
      /** Failed attempts bucketed into fixed categories (never contains error text). */
      errorCategories: Record<string, number>;
    };
    reviews: {
      byVendor: Record<string, { approve: number; veto: number }>;
      outageEvents: number;
    };
    shadow: { total: number; agreed: number; disagreed: number; agreementRate: number };
    outcomes: OutcomeMetrics;
    activeCooldowns: Array<{ provider: string; untilTs: number; reason: string }>;
  } {
    const now = opts.now ?? Date.now();
    const since = opts.sinceMs ?? 0;
    const repoFilter = opts.repo ?? null;

    const excludedIssues = new Set<number>();
    for (const scout of opts.excludeScouts ?? []) {
      const rows = this.db
        .prepare(`SELECT issue_number FROM scout_proposals WHERE scout_name = ? ${repoFilter ? "AND repo = ?" : ""}`)
        .all(...(repoFilter ? [scout, repoFilter] : [scout])) as Array<{ issue_number: number }>;
      for (const r of rows) excludedIssues.add(Number(r.issue_number));
    }
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

    const attParams: unknown[] = [since];
    const attWhere =
      (repoFilter ? "WHERE started_at >= ? AND repo = ?" : "WHERE started_at >= ?") + notExcluded("issue_number");
    if (repoFilter) attParams.push(repoFilter);
    const attemptRows = this.db
      .prepare(`SELECT status, started_at, finished_at, error_message FROM attempts ${attWhere}`)
      .all(...attParams) as Array<{
      status: string;
      started_at: number;
      finished_at: number | null;
      error_message: string | null;
    }>;

    let succeeded = 0;
    let failed = 0;
    let aborted = 0;
    const durationsSec: number[] = [];
    const errorCounts = new Map<string, number>();
    const errorCategories: Record<string, number> = {};

    for (const a of attemptRows) {
      if (a.status === "succeeded") succeeded++;
      else if (a.status === "failed") failed++;
      else if (a.status === "aborted") aborted++;
      if (a.finished_at !== null && a.finished_at >= a.started_at) {
        durationsSec.push((a.finished_at - a.started_at) / 1000);
      }
      if (a.status === "failed" && a.error_message) {
        const key = a.error_message.slice(0, 120);
        errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
        const cat = categorizeAttemptError(a.error_message);
        errorCategories[cat] = (errorCategories[cat] ?? 0) + 1;
      }
    }

    durationsSec.sort((x, y) => x - y);
    const percentile = (arr: number[], p: number): number | null => {
      if (arr.length === 0) return null;
      const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(arr.length * p) - 1));
      return Number(arr[idx]!.toFixed(1));
    };

    const revParams: unknown[] = [since];
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

    const outParams: unknown[] = ["review/outage_started", since];
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
        topErrors,
        errorCategories,
      },
      reviews: {
        byVendor,
        outageEvents: Number(outageRow.cnt),
      },
      shadow: this.getShadowStats(repoFilter, since),
      outcomes: this.computeOutcomeMetrics(threads),
      activeCooldowns: this.listActiveCooldowns(now),
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
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    provider: r.provider === null || r.provider === undefined ? null : String(r.provider),
    model: r.model === null || r.model === undefined ? null : String(r.model),
    promptSha256: r.prompt_sha256 === null || r.prompt_sha256 === undefined ? null : String(r.prompt_sha256),
    workflowSha256: r.workflow_sha256 === null || r.workflow_sha256 === undefined ? null : String(r.workflow_sha256),
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
    status: String(r.status) as DaemonCommandRecord["status"],
    resultJson: r.result_json === null ? null : String(r.result_json),
    errorMessage: r.error_message === null ? null : String(r.error_message),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
