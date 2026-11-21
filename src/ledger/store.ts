import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  LEDGER_SCHEMA_SQL,
  type AttemptKind,
  type AttemptRecord,
  type AuditLogEntry,
  type MergeRecord,
  type ReviewFinding,
  type ReviewRecord,
  type ReviewerVendor,
  type ReviewVerdict,
  type ThreadRecord,
  type ThreadState,
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

  constructor(dbPath: string, opts: { timeZone?: string; readonly?: boolean } = {}) {
    if (!opts.readonly && dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath, { readonly: opts.readonly ?? false });
    this.timeZone = opts.timeZone ?? "America/New_York";
    if (!opts.readonly) {
      this.db.exec(LEDGER_SCHEMA_SQL);
    } else {
      this.db.pragma("busy_timeout = 5000");
    }
  }

  close(): void {
    this.db.close();
  }

  // --- Threads ---

  upsertThread(input: {
    issueNumber: number;
    repo: string;
    title: string;
    themeLabel?: string | null;
    bodySha256: string;
    branchName?: string;
    state?: ThreadState;
    now?: number;
  }): ThreadRecord {
    const now = input.now ?? Date.now();
    const existing = this.getThread(input.issueNumber);
    if (existing) {
      this.db
        .prepare(
          `UPDATE threads SET title = ?, theme_label = ?, updated_at = ? WHERE issue_number = ?`,
        )
        .run(input.title, input.themeLabel ?? existing.themeLabel, now, input.issueNumber);
      return this.getThread(input.issueNumber)!;
    }

    const branchName = input.branchName ?? `factory/${input.issueNumber}`;
    this.db
      .prepare(
        `INSERT INTO threads (
          issue_number, repo, title, theme_label, body_sha256, state, branch_name, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.issueNumber,
        input.repo,
        input.title,
        input.themeLabel ?? null,
        input.bodySha256,
        input.state ?? "queued",
        branchName,
        now,
        now,
      );
    this.appendAudit("thread/created", input.issueNumber, "archangel", {
      title: input.title,
      branchName,
      bodySha256: input.bodySha256,
    });
    return this.getThread(input.issueNumber)!;
  }

  getThread(issueNumber: number): ThreadRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM threads WHERE issue_number = ?`)
      .get(issueNumber) as Record<string, unknown> | undefined;
    return row ? mapThread(row) : null;
  }

  listThreads(states?: ThreadState[]): ThreadRecord[] {
    if (!states || states.length === 0) {
      const rows = this.db
        .prepare(`SELECT * FROM threads ORDER BY issue_number ASC`)
        .all() as Record<string, unknown>[];
      return rows.map(mapThread);
    }
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM threads WHERE state IN (${placeholders}) ORDER BY issue_number ASC`)
      .all(...states) as Record<string, unknown>[];
    return rows.map(mapThread);
  }

  updateThread(
    issueNumber: number,
    patch: Partial<{
      state: ThreadState;
      prNumber: number | null;
      headSha: string | null;
      postHandoff: boolean;
      paseoWorkspaceId: string | null;
      paseoAgentId: string | null;
      implementCount: number;
      revisionCount: number;
      rebaseCount: number;
      gateRerunCount: number;
      gateWaitStartedAt: number | null;
      reviewOutageStartedAt: number | null;
      needsYouReason: string | null;
    }>,
    now = Date.now(),
  ): ThreadRecord {
    const sets: string[] = ["updated_at = ?"];
    const vals: unknown[] = [now];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(val);
    };
    if (patch.state !== undefined) push("state", patch.state);
    if (patch.prNumber !== undefined) push("pr_number", patch.prNumber);
    if (patch.headSha !== undefined) push("head_sha", patch.headSha);
    if (patch.postHandoff !== undefined) push("post_handoff", patch.postHandoff ? 1 : 0);
    if (patch.paseoWorkspaceId !== undefined) push("paseo_workspace_id", patch.paseoWorkspaceId);
    if (patch.paseoAgentId !== undefined) push("paseo_agent_id", patch.paseoAgentId);
    if (patch.implementCount !== undefined) push("implement_count", patch.implementCount);
    if (patch.revisionCount !== undefined) push("revision_count", patch.revisionCount);
    if (patch.rebaseCount !== undefined) push("rebase_count", patch.rebaseCount);
    if (patch.gateRerunCount !== undefined) push("gate_rerun_count", patch.gateRerunCount);
    if (patch.gateWaitStartedAt !== undefined) push("gate_wait_started_at", patch.gateWaitStartedAt);
    if (patch.reviewOutageStartedAt !== undefined) {
      push("review_outage_started_at", patch.reviewOutageStartedAt);
    }
    if (patch.needsYouReason !== undefined) push("needs_you_reason", patch.needsYouReason);

    vals.push(issueNumber);
    this.db.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE issue_number = ?`).run(...vals);
    return this.getThread(issueNumber)!;
  }

  // --- Per-Thread Leases & Stale-Run Sweep ---

  acquireLease(issueNumber: number, owner: string, staleMs: number, now = Date.now()): boolean {
    const cutoff = now - staleMs;
    const res = this.db
      .prepare(
        `UPDATE threads
         SET lease_owner = ?, lease_heartbeat_at = ?, updated_at = ?
         WHERE issue_number = ?
           AND (lease_owner IS NULL OR lease_owner = ? OR lease_heartbeat_at IS NULL OR lease_heartbeat_at < ?)`,
      )
      .run(owner, now, now, issueNumber, owner, cutoff);
    return res.changes === 1;
  }

  heartbeatLease(issueNumber: number, owner: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE threads SET lease_heartbeat_at = ?, updated_at = ?
         WHERE issue_number = ? AND lease_owner = ?`,
      )
      .run(now, now, issueNumber, owner);
  }

  releaseLease(issueNumber: number, owner: string, now = Date.now()): void {
    this.db
      .prepare(
        `UPDATE threads SET lease_owner = NULL, lease_heartbeat_at = NULL, updated_at = ?
         WHERE issue_number = ? AND lease_owner = ?`,
      )
      .run(now, issueNumber, owner);
  }

  /**
   * Startup stale-run sweep (Opus edge case): recovers from laptop sleep/crashes by marking
   * abandoned running attempts as failed and clearing stale leases so the reconciler can decide next action.
   */
  sweepStaleRuns(staleMs: number, now = Date.now()): number[] {
    const cutoff = now - staleMs;
    const staleThreads = this.db
      .prepare(
        `SELECT issue_number, state FROM threads
         WHERE (lease_owner IS NOT NULL AND (lease_heartbeat_at IS NULL OR lease_heartbeat_at < ?))
            OR state IN ('implementing', 'revising', 'rebasing', 'reviewing')`,
      )
      .all(cutoff) as Array<{ issue_number: number; state: ThreadState }>;

    const recovered: number[] = [];
    const tx = this.db.transaction(() => {
      for (const row of staleThreads) {
        this.db
          .prepare(
            `UPDATE attempts SET status = 'failed', error_message = 'stale run swept on startup', finished_at = ?
             WHERE issue_number = ? AND status = 'running'`,
          )
          .run(now, row.issue_number);

        // Return interrupted active states to safe resumable states (Pine: pause/safe recovery).
        const nextState: ThreadState =
          row.state === "reviewing" ? "awaiting_gate" : "queued";
        this.db
          .prepare(
            `UPDATE threads
             SET state = ?, lease_owner = NULL, lease_heartbeat_at = NULL, updated_at = ?
             WHERE issue_number = ?`,
          )
          .run(nextState, now, row.issue_number);

        this.appendAudit("thread/stale_swept", row.issue_number, "archangel", {
          previousState: row.state,
          nextState,
        });
        recovered.push(row.issue_number);
      }
    });
    tx();
    return recovered;
  }

  // --- Attempts ---

  startAttempt(issueNumber: number, kind: AttemptKind, now = Date.now()): AttemptRecord {
    const info = this.db
      .prepare(
        `INSERT INTO attempts (issue_number, kind, status, started_at) VALUES (?, ?, 'running', ?)`,
      )
      .run(issueNumber, kind, now);
    const id = Number(info.lastInsertRowid);
    this.appendAudit("attempt/started", issueNumber, "archangel", { attemptId: id, kind });
    return this.getAttempt(id)!;
  }

  finishAttempt(
    attemptId: number,
    result: {
      status: "succeeded" | "failed" | "aborted";
      headSha?: string | null;
      costUsd?: number;
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
    if (cost > 0) {
      this.addSpend(cost, now);
    }
    const attempt = this.getAttempt(attemptId)!;
    this.appendAudit("attempt/finished", attempt.issueNumber, "archangel", {
      attemptId,
      status: result.status,
      headSha: result.headSha ?? null,
      costUsd: cost,
      error: result.errorMessage ?? null,
    });
    return attempt;
  }

  getAttempt(id: number): AttemptRecord | null {
    const row = this.db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapAttempt(row) : null;
  }

  // --- Recorded Pushed SHAs (ADR-0004 / B7) ---

  recordPushedSha(
    sha: string,
    issueNumber: number,
    origin: "broker" | "owner_resume",
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pushed_shas (sha, issue_number, origin, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(sha, issueNumber, origin, now);
    this.appendAudit("broker/sha_recorded", issueNumber, origin, { sha });
  }

  isKnownSha(issueNumber: number, sha: string): { known: boolean; origin: string | null } {
    const row = this.db
      .prepare(`SELECT origin FROM pushed_shas WHERE sha = ? AND issue_number = ?`)
      .get(sha, issueNumber) as { origin: string } | undefined;
    return row ? { known: true, origin: row.origin } : { known: false, origin: null };
  }

  // --- Reviews (Runtime records SHA, never model-echoed — B7) ---

  recordReview(input: {
    issueNumber: number;
    headSha: string;
    vendor: ReviewerVendor;
    verdict: ReviewVerdict;
    findings: ReviewFinding[];
    costUsd: number;
    now?: number;
  }): ReviewRecord {
    const now = input.now ?? Date.now();
    const cost = Math.max(0, input.costUsd);
    this.db
      .prepare(
        `INSERT INTO reviews (issue_number, head_sha, vendor, verdict, findings_json, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_number, head_sha, vendor) DO UPDATE SET
           verdict = excluded.verdict,
           findings_json = excluded.findings_json,
           cost_usd = excluded.cost_usd,
           created_at = excluded.created_at`,
      )
      .run(
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
    this.appendAudit("review/recorded", input.issueNumber, input.vendor, {
      headSha: input.headSha,
      verdict: input.verdict,
      findingsCount: input.findings.length,
      costUsd: cost,
    });
    return this.getReviewsForSha(input.issueNumber, input.headSha).find(
      (r) => r.vendor === input.vendor,
    )!;
  }

  getReviewsForSha(issueNumber: number, headSha: string): ReviewRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM reviews WHERE issue_number = ? AND head_sha = ? ORDER BY vendor ASC`)
      .all(issueNumber, headSha) as Record<string, unknown>[];
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
  }): MergeRecord {
    const now = input.now ?? Date.now();
    const dayKey = formatDayKey(now, this.timeZone);
    const info = this.db
      .prepare(
        `INSERT INTO merges (issue_number, pr_number, head_sha, squash_sha, shadow_only, day_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.issueNumber,
        input.prNumber,
        input.headSha,
        input.squashSha ?? null,
        input.shadowOnly ? 1 : 0,
        dayKey,
        now,
      );
    this.appendAudit(input.shadowOnly ? "lander/shadow_ready" : "lander/merged", input.issueNumber, "lander", {
      prNumber: input.prNumber,
      headSha: input.headSha,
      squashSha: input.squashSha ?? null,
    });
    return this.getMerge(Number(info.lastInsertRowid))!;
  }

  getMerge(id: number): MergeRecord | null {
    const row = this.db.prepare(`SELECT * FROM merges WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapMerge(row) : null;
  }

  getAutoMergeCountToday(now = Date.now()): number {
    const dayKey = formatDayKey(now, this.timeZone);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM merges WHERE day_key = ? AND shadow_only = 0`)
      .get(dayKey) as { cnt: number };
    return row.cnt;
  }

  listPendingPostMergeChecks(): MergeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM merges WHERE shadow_only = 0 AND squash_sha IS NOT NULL AND main_status IN ('pending', 'rerun_once') ORDER BY created_at ASC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(mapMerge);
  }

  updateMergeMainStatus(
    mergeId: number,
    status: MergeRecord["mainStatus"],
    revertPrNumber?: number | null,
  ): void {
    this.db
      .prepare(`UPDATE merges SET main_status = ?, revert_pr_number = COALESCE(?, revert_pr_number) WHERE id = ?`)
      .run(status, revertPrNumber ?? null, mergeId);
  }

  markShadowDisagree(issueNumber: number, disagreed = true): void {
    this.db
      .prepare(`UPDATE merges SET disagreed = ? WHERE issue_number = ? AND shadow_only = 1`)
      .run(disagreed ? 1 : 0, issueNumber);
    this.appendAudit("shadow/disagree", issueNumber, "owner", { disagreed });
  }

  getShadowStats(): { total: number; agreed: number; disagreed: number; agreementRate: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN disagreed = 1 THEN 1 ELSE 0 END) AS disagreed
         FROM merges WHERE shadow_only = 1`,
      )
      .get() as { total: number; disagreed: number | null };
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

  // --- Spend Accounting ($20/day hard cap — B9) ---

  addSpend(usd: number, now = Date.now()): number {
    const dayKey = formatDayKey(now, this.timeZone);
    this.db
      .prepare(
        `INSERT INTO daily_spend (day_key, usd, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(day_key) DO UPDATE SET usd = usd + excluded.usd, updated_at = excluded.updated_at`,
      )
      .run(dayKey, usd, now);
    return this.getSpendToday(now);
  }

  getSpendToday(now = Date.now()): number {
    const dayKey = formatDayKey(now, this.timeZone);
    const row = this.db.prepare(`SELECT usd FROM daily_spend WHERE day_key = ?`).get(dayKey) as
      | { usd: number }
      | undefined;
    return row?.usd ?? 0;
  }

  // --- Global Circuit Breaker (Red Main — B8) ---

  setCircuitBreaker(tripped: boolean, reason?: string, now = Date.now()): void {
    this.setSystemState("circuit_breaker_tripped", tripped ? "1" : "0", now);
    this.setSystemState("circuit_breaker_reason", reason ?? "", now);
    this.appendAudit("system/circuit_breaker", null, "archangel", { tripped, reason: reason ?? "" });
  }

  getCircuitBreaker(): { tripped: boolean; reason: string } {
    return {
      tripped: this.getSystemState("circuit_breaker_tripped") === "1",
      reason: this.getSystemState("circuit_breaker_reason") ?? "",
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
  ): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (ts, topic, issue_number, actor, payload_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(now, topic, issueNumber, actor, JSON.stringify(payload));
  }

  listAudit(opts: { topicPrefix?: string; issueNumber?: number; limit?: number } = {}): AuditLogEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
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
      topic: String(r.topic),
      issueNumber: r.issue_number === null ? null : Number(r.issue_number),
      actor: String(r.actor),
      payloadJson: String(r.payload_json),
    }));
  }
}

function mapThread(r: Record<string, unknown>): ThreadRecord {
  return {
    issueNumber: Number(r.issue_number),
    repo: String(r.repo),
    title: String(r.title),
    themeLabel: r.theme_label === null ? null : String(r.theme_label),
    bodySha256: String(r.body_sha256),
    state: String(r.state) as ThreadState,
    branchName: String(r.branch_name),
    prNumber: r.pr_number === null ? null : Number(r.pr_number),
    headSha: r.head_sha === null ? null : String(r.head_sha),
    postHandoff: Number(r.post_handoff) === 1,
    paseoWorkspaceId: r.paseo_workspace_id === null ? null : String(r.paseo_workspace_id),
    paseoAgentId: r.paseo_agent_id === null ? null : String(r.paseo_agent_id),
    implementCount: Number(r.implement_count),
    revisionCount: Number(r.revision_count),
    rebaseCount: Number(r.rebase_count),
    gateRerunCount: Number(r.gate_rerun_count),
    gateWaitStartedAt: r.gate_wait_started_at === null ? null : Number(r.gate_wait_started_at),
    reviewOutageStartedAt:
      r.review_outage_started_at === null ? null : Number(r.review_outage_started_at),
    needsYouReason: r.needs_you_reason === null ? null : String(r.needs_you_reason),
    leaseOwner: r.lease_owner === null ? null : String(r.lease_owner),
    leaseHeartbeatAt: r.lease_heartbeat_at === null ? null : Number(r.lease_heartbeat_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function mapAttempt(r: Record<string, unknown>): AttemptRecord {
  return {
    id: Number(r.id),
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
    issueNumber: Number(r.issue_number),
    prNumber: Number(r.pr_number),
    headSha: String(r.head_sha),
    squashSha: r.squash_sha === null ? null : String(r.squash_sha),
    shadowOnly: Number(r.shadow_only) === 1,
    disagreed: Number(r.disagreed) === 1,
    dayKey: String(r.day_key),
    mainStatus: String(r.main_status) as MergeRecord["mainStatus"],
    revertPrNumber: r.revert_pr_number === null ? null : Number(r.revert_pr_number),
    createdAt: Number(r.created_at),
  };
}
