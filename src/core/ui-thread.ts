import fs from "node:fs";
import type { Ledger } from "../ledger/store.js";

/** Read-only views for the Thread detail page. Every string here is untrusted text: the UI renders it only as React children. */

export interface TimelineEvent {
  ts: number;
  kind: "audit" | "attempt" | "review" | "merge";
  title: string;
  /** `failed` rows are highlighted; `info` is neutral. */
  tone: "ok" | "failed" | "info";
  details: Array<{ label: string; value: string }>;
}

export interface ThreadDetail {
  generatedAt: number;
  repo: string;
  issueNumber: number;
  title: string;
  phase: string;
  prNumber: number | null;
  events: TimelineEvent[];
  /** The audit log was cut at AUDIT_LIMIT rows (newest kept). */
  auditTruncated: boolean;
}

export const AUDIT_LIMIT = 500;
const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** Pure read; null when the Ledger has no such Thread. */
export function buildThreadDetail(ledger: Ledger, repo: string, issueNumber: number, now = Date.now()): ThreadDetail | null {
  const view = ledger.forRepo(repo);
  const thread = view.getThread(issueNumber);
  if (!thread) return null;
  const events: TimelineEvent[] = [];

  const audit = view.listAudit({ repo, issueNumber, limit: AUDIT_LIMIT });
  for (const a of [...audit].reverse()) {
    events.push({ ts: a.ts, kind: "audit", title: a.topic, tone: /fail|reject|error|veto/i.test(a.topic) ? "failed" : "info", details: [{ label: "actor", value: a.actor }, { label: "payload", value: clip(a.payloadJson) }] });
  }
  for (const a of view.listAttemptsFor(issueNumber)) {
    const duration = a.finishedAt === null ? "running" : `${Math.round((a.finishedAt - a.startedAt) / 1000)}s`;
    events.push({
      ts: a.startedAt,
      kind: "attempt",
      title: `Attempt #${a.id}: ${a.kind}, ${a.status}`,
      tone: a.status === "failed" ? "failed" : a.status === "succeeded" ? "ok" : "info",
      details: [
        { label: "provider", value: [a.provider, a.model].filter(Boolean).join(" / ") || "unknown" },
        { label: "duration", value: duration },
        ...(a.errorMessage ? [{ label: "error category", value: a.errorCategory ?? "other" }] : []),
        ...(a.transcriptPath ? [{ label: "transcript", value: a.transcriptPath }] : []),
      ],
    });
  }
  for (const r of view.listReviewsFor(issueNumber)) {
    let findings: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.findingsJson);
      if (Array.isArray(parsed)) {
        findings = parsed.slice(0, 10).map((f) => {
          const o = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
          return clip(`${String(o.severity ?? "?")} ${String(o.file ?? "")}: ${String(o.summary ?? "")}`, 300);
        });
      }
    } catch {
      findings = ["findings unreadable"];
    }
    events.push({
      ts: r.createdAt,
      kind: "review",
      title: `Review by ${r.vendor}: ${r.verdict}`,
      tone: r.verdict === "veto" ? "failed" : "ok",
      details: [{ label: "head", value: r.headSha.slice(0, 8) }, ...findings.map((f) => ({ label: "finding", value: f }))],
    });
  }
  for (const m of view.listMergesFor(issueNumber)) {
    events.push({
      ts: m.createdAt,
      kind: "merge",
      title: m.shadowOnly ? `Shadow merge verdict for PR #${m.prNumber}` : `Merged PR #${m.prNumber}`,
      tone: m.disagreed ? "failed" : "ok",
      details: [{ label: "head", value: m.headSha.slice(0, 8) }, { label: "main watch", value: m.mainWatch.kind }, ...(m.disagreed ? [{ label: "owner", value: "disagreed" }] : [])],
    });
  }
  events.sort((a, b) => a.ts - b.ts);
  const phase = thread.phase;
  return {
    generatedAt: now,
    repo,
    issueNumber,
    title: thread.title,
    phase: phase.kind,
    prNumber: "prNumber" in phase && typeof phase.prNumber === "number" ? phase.prNumber : null,
    events,
    auditTruncated: audit.length >= AUDIT_LIMIT,
  };
}

export interface LogEntry {
  ts: string;
  level: string;
  event: string;
  message: string;
}
export interface LogsPayload {
  generatedAt: number;
  /** The log file does not exist (distinct from "exists but nothing for this Thread"). */
  missing: boolean;
  entries: LogEntry[];
}

const TAIL_BYTES = 2_000_000;
export const LOG_MAX = 500;

/** Tails the JSONL log for one Thread. Only ts/level/event/message are returned, never the free-form `data`. */
export function readLogs(file: string | null, repo: string, issueNumber: number, limit: number, now = Date.now()): LogsPayload {
  if (file === null || !fs.existsSync(file)) return { generatedAt: now, missing: true, entries: [] };
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  let text: string;
  try {
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    text = buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split("\n");
  if (size > TAIL_BYTES) lines.shift(); // the first line is probably cut
  const entries: LogEntry[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.repo !== repo || r.issue !== issueNumber) continue;
      entries.push({ ts: String(r.ts ?? ""), level: String(r.level ?? "info"), event: String(r.event ?? ""), message: clip(String(r.message ?? ""), 500) });
    } catch {
      // a torn or foreign line is skipped
    }
  }
  return { generatedAt: now, missing: false, entries: entries.slice(-Math.min(Math.max(1, limit), LOG_MAX)) };
}
