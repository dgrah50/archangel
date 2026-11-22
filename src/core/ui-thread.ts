import type { Ledger } from "../ledger/store.js";
import { tryParseJson } from "./json.js";

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
  /** Latest Gate result recorded in the Ledger audit (`gate/*` rows): one passed check, or one failed check per violation. Empty when none. */
  gate: Array<{ label: string; passed: boolean }>;
  /** Diff size the Broker recorded in the latest `thread/pr_pushed` or `gate/local_failed_revising` audit row, with the repo's cached Gate limits (null when none cached). Null when no row recorded it. */
  diff: { files: number; nonTestLines: number; totalLines: number; limits: { maxNonTestLines: number; maxTotalLines: number; maxFiles: number } | null } | null;
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
  const parsed = tryParseJson(json);
  if (!parsed.ok) return ["findings unreadable"];
  if (!Array.isArray(parsed.value)) return [];
  return parsed.value.slice(0, limit).map((f) => {
    const o = (typeof f === "object" && f !== null ? f : {}) as Record<string, unknown>;
    return clip(`${String(o.severity ?? "?")} ${String(o.file ?? "")}: ${String(o.summary ?? "")}`, 300);
  });
}

function gateLimits(ledger: Ledger, repo: string): NonNullable<ThreadDetail["diff"]>["limits"] {
  const wf = ledger.listCachedWorkflows().find((c) => c.repo === repo)?.workflow as { status?: unknown; gate?: Record<string, unknown> } | null | undefined;
  const g = wf?.status === "ok" ? wf.gate : undefined;
  if (!g || typeof g.maxNonTestLines !== "number" || typeof g.maxTotalLines !== "number" || typeof g.maxFiles !== "number") return null;
  return { maxNonTestLines: g.maxNonTestLines, maxTotalLines: g.maxTotalLines, maxFiles: g.maxFiles };
}

/** Pure read; null when the Ledger has no such Thread. */
export function buildThreadDetail(ledger: Ledger, repo: string, issueNumber: number, now = Date.now()): ThreadDetail | null {
  const view = ledger.forRepo(repo);
  const thread = view.getThread(issueNumber);
  if (!thread) return null;
  const events: TimelineEvent[] = [];
  let gate: ThreadDetail["gate"] = [];

  const audit = view.listAudit({ repo, issueNumber, limit: AUDIT_LIMIT });
  const lastGate = audit.find((a) => a.topic === "gate/passed" || a.topic === "gate/local_failed_revising");
  if (lastGate?.topic === "gate/passed") gate = [{ label: "Gate passed", passed: true }];
  else if (lastGate) {
    let violations: unknown[] = [];
    const parsedGate = tryParseJson(lastGate.payloadJson);
    if (parsedGate.ok && typeof parsedGate.value === "object" && parsedGate.value !== null) {
      const v = (parsedGate.value as { violations?: unknown }).violations;
      if (Array.isArray(v)) violations = v;
    }
    gate = violations.length > 0 ? violations.slice(0, 10).map((v) => ({ label: clip(String(v), 200), passed: false })) : [{ label: "Gate failed", passed: false }];
  }
  let diff: ThreadDetail["diff"] = null;
  for (const a of audit) {
    if (a.topic !== "thread/pr_pushed" && a.topic !== "gate/local_failed_revising") continue;
    const p = tryParseJson(a.payloadJson);
    const d = p.ok && typeof p.value === "object" && p.value !== null ? (p.value as { diff?: Partial<Record<"files" | "nonTestLines" | "totalLines", unknown>> }).diff : undefined;
    if (d && typeof d.files === "number" && typeof d.nonTestLines === "number" && typeof d.totalLines === "number") {
      diff = { files: d.files, nonTestLines: d.nonTestLines, totalLines: d.totalLines, limits: gateLimits(ledger, repo) };
      break;
    }
  }
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
    gate,
    diff,
    auditTruncated: audit.length >= AUDIT_LIMIT,
  };
}
