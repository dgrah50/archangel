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
  /** From the Ledger only (live check state lives on GitHub): what the latest Recap would say about the head. */
  recap: { headSha: string | null; themeLabel: string | null; implementers: string[]; attempts: string; reviews: Array<{ vendor: string; verdict: string }> };
  /** What holds this Thread, from the Ledger: an owner decision, or a review veto on the head. Empty when nothing is recorded. */
  blockers: Array<{ title: string; detail: string; owner: boolean }>;
  /** The audit log was cut at AUDIT_LIMIT rows (newest kept). */
  auditTruncated: boolean;
}

export const AUDIT_LIMIT = 500;
const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}...` : s);

function reviewFindings(json: string, limit = 1): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, limit).map((f) => {
      const o = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
      return clip(`${String(o.severity ?? "?")} ${String(o.file ?? "")}: ${String(o.summary ?? "")}`, 300);
    });
  } catch {
    return ["findings unreadable"];
  }
}

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
    const findings = reviewFindings(r.findingsJson, 10);
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
  const headSha = "headSha" in phase && typeof phase.headSha === "string" ? phase.headSha : null;
  const atHead = headSha === null ? [] : view.listReviewsFor(issueNumber).filter((r) => r.headSha === headSha);
  const blockers: ThreadDetail["blockers"] = [];
  if (phase.kind === "needs_you") blockers.push({ title: "Owner decision pending", detail: phase.reason, owner: true });
  for (const r of atHead.filter((x) => x.verdict === "veto")) {
    blockers.push({ title: `Review veto from ${r.vendor}`, detail: reviewFindings(r.findingsJson)[0] ?? "no findings recorded", owner: false });
  }
  return {
    generatedAt: now,
    repo,
    issueNumber,
    title: thread.title,
    phase: phase.kind,
    prNumber: "prNumber" in phase && typeof phase.prNumber === "number" ? phase.prNumber : null,
    recap: {
      headSha: headSha === null ? null : headSha.slice(0, 8),
      themeLabel: thread.themeLabel,
      implementers: thread.implementerVendors,
      attempts: `implement ${thread.implementCount}, revision ${thread.revisionCount}, rebase ${thread.rebaseCount}`,
      reviews: atHead.map((r) => ({ vendor: r.vendor, verdict: r.verdict })),
    },
    blockers,
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
