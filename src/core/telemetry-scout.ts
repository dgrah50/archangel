import type { Ledger } from "../ledger/store.js";

/**
 * The telemetry Scout: mechanical, no model. Once an hour it compares the last 24h of local telemetry against the trailing
 * 7 days before that and reports what is abnormal. Its findings are closed-shape numbers, so they are trustworthy aggregates.
 * All thresholds below are PROVISIONAL: they are first guesses to be tuned against real data.
 */

export const ANOMALY_METRICS = [
  "tick_slowdown",
  "github_latency",
  "github_errors",
  "github_429s",
  "attempt_slowdown",
  "attempt_failures",
  "account_quota",
  "gate_timeouts",
] as const;
export type AnomalyMetric = (typeof ANOMALY_METRICS)[number];

export interface Anomaly {
  metric: AnomalyMetric;
  /** The trailing 7-day baseline, in the metric's unit (per-day average for counts). */
  baseline: number;
  /** The last 24h. */
  observed: number;
  ratio: number;
}

const DAY = 86_400_000;
export const TELEMETRY_SCOUT_EVERY_MS = 3_600_000;

type Row = { value: number; tags: Record<string, string> };
/** A reading of one window: the number being judged and how many samples it rests on. */
type Reading = { value: number; n: number };

function pctl(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
}

interface Check {
  metric: AnomalyMetric;
  event: string;
  /** Host-wide events carry no repo. */
  hostWide?: boolean;
  /** Fewest samples in the 24h window and in the baseline before a verdict is given. */
  minWindow: number;
  minBase: number;
  /** Observed must be at least this multiple of baseline (baseline floored at `floor`) and at least this big. */
  minRatio: number;
  minObserved: number;
  floor: number;
  read(rows: Row[]): Reading | null;
}

const share = (rows: Row[], hit: (r: Row) => boolean): Reading => ({ value: rows.filter(hit).length / rows.length, n: rows.length });
const count = (rows: Row[]): Reading => ({ value: rows.length, n: rows.length });
const p = (q: number) => (rows: Row[]): Reading => ({ value: pctl(rows.map((r) => r.value), q), n: rows.length });
const only = (tag: string, v: string) => (rows: Row[]) => rows.filter((r) => r.tags[tag] === v);

// Provisional thresholds.
const CHECKS: Check[] = [
  { metric: "tick_slowdown", event: "tick_ms", minWindow: 30, minBase: 100, minRatio: 1.5, minObserved: 2_000, floor: 1, read: p(0.5) },
  { metric: "github_latency", event: "github_call_ms", minWindow: 50, minBase: 200, minRatio: 2, minObserved: 500, floor: 1, read: p(0.95) },
  { metric: "github_errors", event: "github_call_ms", minWindow: 30, minBase: 100, minRatio: 3, minObserved: 0.1, floor: 0.01, read: (rows) => share(rows, (r) => r.tags.status === "5xx" || r.tags.status === "error") },
  { metric: "github_429s", event: "github_call_ms", minWindow: 0, minBase: 0, minRatio: 2, minObserved: 3, floor: 1, read: (rows) => count(only("status", "429")(rows)) },
  { metric: "attempt_slowdown", event: "attempt_ms", minWindow: 5, minBase: 10, minRatio: 1.5, minObserved: 60_000, floor: 1, read: p(0.95) },
  { metric: "attempt_failures", event: "attempt_ms", minWindow: 5, minBase: 10, minRatio: 2, minObserved: 0.5, floor: 0.05, read: (rows) => share(rows.filter((r) => r.tags.outcome !== "aborted"), (r) => r.tags.outcome === "failed") },
  { metric: "account_quota", event: "account_cooldown", hostWide: true, minWindow: 0, minBase: 0, minRatio: 2, minObserved: 3, floor: 1, read: (rows) => count(rows) },
  { metric: "gate_timeouts", event: "gate_ms", minWindow: 0, minBase: 0, minRatio: 2, minObserved: 3, floor: 1, read: (rows) => count(only("outcome", "timeout")(rows)) },
];

/** Count checks compare a day with the baseline's per-day average; the quota check judges the worst single account. */
function isCount(c: Check): boolean {
  return c.metric === "github_429s" || c.metric === "account_quota" || c.metric === "gate_timeouts";
}

function judge(c: Check, window: Row[], base: Row[]): Anomaly | null {
  const groups = c.metric === "account_quota" ? [...new Set(window.map((r) => r.tags.account))] : [undefined];
  let worst: Anomaly | null = null;
  for (const g of groups) {
    const pick = (rows: Row[]) => (g === undefined ? rows : rows.filter((r) => r.tags.account === g));
    const w = pick(window);
    const b = pick(base);
    if (w.length === 0 || w.length < c.minWindow || b.length < c.minBase) continue;
    const obs = c.read(w);
    const old = b.length === 0 ? { value: 0, n: 0 } : c.read(b);
    if (!obs || !old) continue;
    const baseline = isCount(c) ? old.value / 7 : old.value;
    const ratio = obs.value / Math.max(baseline, c.floor);
    if (obs.value >= c.minObserved && ratio >= c.minRatio && (!worst || ratio > worst.ratio)) {
      worst = { metric: c.metric, baseline: round(baseline), observed: round(obs.value), ratio: round(ratio) };
    }
  }
  return worst;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** What is abnormal for this repo right now: the last 24h against the 7 days before it. Empty when all is normal. */
export function detectAnomalies(ledger: Ledger, now: number): Anomaly[] {
  const out: Anomaly[] = [];
  for (const c of CHECKS) {
    const repo = c.hostWide ? null : ledger.repo;
    const window = ledger.listTelemetry(c.event, now - DAY, now + 1, repo);
    const base = ledger.listTelemetry(c.event, now - 8 * DAY, now - DAY, repo);
    const found = judge(c, window, base);
    if (found) out.push(found);
  }
  return out;
}

/** One anomaly is one signal per metric, repo and UTC day: a sustained regression is recorded once a day, not every hour. */
export function anomalyEventId(metric: AnomalyMetric, now: number): string {
  return `${metric}:${new Date(now).toISOString().slice(0, 10)}`;
}

/** The one-line meaning of each metric, for the dashboard and for issue rules to quote. */
export const ANOMALY_TEXT: Record<AnomalyMetric, { title: string; unit: "ms" | "share" | "count" }> = {
  tick_slowdown: { title: "Ticks are slower than usual", unit: "ms" },
  github_latency: { title: "GitHub calls are slower than usual", unit: "ms" },
  github_errors: { title: "More GitHub calls are failing", unit: "share" },
  github_429s: { title: "GitHub is rate limiting us", unit: "count" },
  attempt_slowdown: { title: "Attempts take longer than usual", unit: "ms" },
  attempt_failures: { title: "More Attempts are failing", unit: "share" },
  account_quota: { title: "An account keeps hitting its usage limit", unit: "count" },
  gate_timeouts: { title: "The Gate keeps timing out", unit: "count" },
};
