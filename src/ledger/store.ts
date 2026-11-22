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
    this.repo = opts.repo ?? "dgrah50/gijq";
    this.timeZone = opts.timeZone ?? "America/New_York";
    if (!opts.readonly) {
      this.db.exec(LEDGER_SCHEMA_SQL);
      const cols = this.db.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "implementer_vendors_json")) {
        this.db.exec("ALTER TABLE threads ADD COLUMN implementer_vendors_json TEXT NOT NULL DEFAULT '[]'");
      }
    } else {
      this.db.pragma("busy_timeout = 5000");
    }
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
          repo, issue_number, title, theme_label, body_sha256, phase_json, version, mode, branch_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
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

  listOutbox(repo = this.repo, limit = 50): OutboxRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM outbox WHERE repo = ? ORDER BY id ASC LIMIT ?`)
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
    now?: number;
    repo?: string;
  }): ReviewRecord {
    const repo = input.repo ?? this.repo;
    const now = input.now ?? Date.now();
    const cost = Math.max(0, input.costUsd);
    this.db
      .prepare(
        `INSERT INTO reviews (repo, issue_number, head_sha, vendor, verdict, findings_json, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, issue_number, head_sha, vendor) DO UPDATE SET
           verdict = excluded.verdict,
           findings_json = excluded.findings_json,
           cost_usd = excluded.cost_usd,
           created_at = excluded.created_at`,
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
    now?: number;
    repo?: string;
  }): MergeRecord {
    const repo = input.repo ?? this.repo;
    const now = input.now ?? Date.now();
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
        `INSERT INTO merges (repo, issue_number, pr_number, head_sha, squash_sha, shadow_only, day_key, main_watch_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
   * Synchronizes shadow disagreement idempotently (no duplicate audit rows on unchanged ticks).
   */
  markShadowDisagree(issueNumber: number, disagreed = true, repo = this.repo): void {
    const flag = disagreed ? 1 : 0;
    const res = this.db
      .prepare(
        `UPDATE merges SET disagreed = ? WHERE repo = ? AND issue_number = ? AND shadow_only = 1 AND disagreed != ?`,
      )
      .run(flag, repo, issueNumber, flag);
    if (res.changes > 0) {
      this.appendAudit("shadow/disagree", issueNumber, "owner", { disagreed }, Date.now(), repo);
    }
  }

  getShadowStats(repo: string | null = null): {
    total: number;
    agreed: number;
    disagreed: number;
    agreementRate: number;
  } {
    const row = (
      repo === null
        ? this.db
            .prepare(
              `SELECT COUNT(*) AS total, SUM(CASE WHEN disagreed = 1 THEN 1 ELSE 0 END) AS disagreed
               FROM merges WHERE shadow_only = 1`,
            )
            .get()
        : this.db
            .prepare(
              `SELECT COUNT(*) AS total, SUM(CASE WHEN disagreed = 1 THEN 1 ELSE 0 END) AS disagreed
               FROM merges WHERE repo = ? AND shadow_only = 1`,
            )
            .get(repo)
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

  // ---- Operational Metrics & Self-Improvement Telemetry ----

  computeMetrics(opts: { repo?: string | null; sinceMs?: number; now?: number } = {}): {
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
    };
    reviews: {
      byVendor: Record<string, { approve: number; veto: number }>;
      outageEvents: number;
    };
    shadow: { total: number; agreed: number; disagreed: number; agreementRate: number };
    activeCooldowns: Array<{ provider: string; untilTs: number; reason: string }>;
  } {
    const now = opts.now ?? Date.now();
    const since = opts.sinceMs ?? 0;
    const repoFilter = opts.repo ?? null;

    const allThreads = repoFilter ? this.listThreads(undefined, repoFilter) : this.listAllThreads();
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
    const attWhere = repoFilter ? "WHERE started_at >= ? AND repo = ?" : "WHERE started_at >= ?";
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
      }
    }

    durationsSec.sort((x, y) => x - y);
    const percentile = (arr: number[], p: number): number | null => {
      if (arr.length === 0) return null;
      const idx = Math.min(arr.length - 1, Math.floor((arr.length - 1) * p));
      return Number(arr[idx]!.toFixed(1));
    };

    const revParams: unknown[] = [since];
    const revWhere = repoFilter ? "WHERE created_at >= ? AND repo = ?" : "WHERE created_at >= ?";
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
    const outWhere = repoFilter ? "WHERE topic = ? AND ts >= ? AND repo = ?" : "WHERE topic = ? AND ts >= ?";
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
      },
      reviews: {
        byVendor,
        outageEvents: Number(outageRow.cnt),
      },
      shadow: this.getShadowStats(repoFilter),
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
