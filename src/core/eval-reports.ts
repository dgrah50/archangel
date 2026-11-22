import fs from "node:fs";
import path from "node:path";
import type { EvalReport } from "./eval.js";
import type { ReplayReport } from "./replay.js";

export const REPORTS_KEEP = 20;
export type ReportKind = "eval" | "replay";
const FILE_RE = /^(eval|replay)-(\d{13})\.json$/;

export const reportsDir = (dataDir: string) => path.join(dataDir, "evals");

/** Writes `evals/<kind>-<ms>.json` atomically (temp file in the same directory, then rename) and keeps the newest REPORTS_KEEP of that kind. */
export function saveReport(dataDir: string, kind: "eval", report: EvalReport, now?: number): string;
export function saveReport(dataDir: string, kind: "replay", report: ReplayReport[], now?: number): string;
export function saveReport(dataDir: string, kind: ReportKind, report: EvalReport | ReplayReport[], now = Date.now()): string {
  const dir = reportsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${now}.json`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ kind, savedAt: now, report }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  const mine = fs.readdirSync(dir).filter((f) => FILE_RE.exec(f)?.[1] === kind).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - REPORTS_KEEP))) fs.rmSync(path.join(dir, old), { force: true });
  return file;
}

export type RunSummary =
  | { file: string; kind: "eval"; savedAt: number; unreadable: false; verdict: "pass" | "fail" | "INSUFFICIENT DATA"; candidate: string; files: string[]; split: string; scored: number; newFalseApprovals: number; newFalseVetoes: number; reasons: string[]; cases: number; milestone: { current: number; next: number | null } }
  | { file: string; kind: "replay"; savedAt: number; unreadable: false; verdict: "pass" | "fail"; repos: string[]; replayed: number; regressions: number; mutants: number }
  | { file: string; kind: ReportKind; savedAt: number; unreadable: true; error: string };

export interface EvalsState {
  generatedAt: number;
  /** Newest first. */
  runs: RunSummary[];
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);

function summarize(file: string, kind: ReportKind, savedAt: number, raw: unknown): RunSummary {
  const bad = (error: string): RunSummary => ({ file, kind, savedAt, unreadable: true, error });
  if (!obj(raw) || raw.kind !== kind || !("report" in raw)) return bad("not an archangel report");
  const r = raw.report;
  if (kind === "eval") {
    if (!obj(r) || !obj(r.candidate) || !obj(r.scored) || !obj(r.counts) || !obj(r.milestones)) return bad("unexpected eval report shape");
    const verdict = r.result === "pass" ? "pass" : r.result === "fail" ? "fail" : r.result === "insufficient" ? "INSUFFICIENT DATA" : null;
    const files = strs(r.candidate.files);
    const nfa = strs(r.newFalseApprovals);
    const nfv = strs(r.newFalseVetoes);
    const reasons = strs(r.reasons);
    const cases = num(r.counts.total);
    const cur = num(r.milestones.current);
    if (!verdict || !files || !nfa || !nfv || !reasons || typeof r.candidate.patchSha256 !== "string" || Number.isNaN(cases) || Number.isNaN(cur)) return bad("unexpected eval report shape");
    const next = r.milestones.next === null ? null : num(r.milestones.next);
    return { file, kind, savedAt, unreadable: false, verdict, candidate: r.candidate.patchSha256.slice(0, 12), files, split: String(r.split), scored: num(r.scored.good) + num(r.scored.bad), newFalseApprovals: nfa.length, newFalseVetoes: nfv.length, reasons, cases, milestone: { current: cur, next: next === null || Number.isNaN(next) ? null : next } };
  }
  if (!Array.isArray(r) || !r.every((x) => obj(x) && typeof x.repo === "string" && Array.isArray(x.mutants) && !Number.isNaN(num(x.replayed)) && !Number.isNaN(num(x.regressions)))) return bad("unexpected replay report shape");
  const reports = r as unknown as ReplayReport[];
  const regressions = reports.reduce((t, x) => t + x.regressions, 0);
  return { file, kind, savedAt, unreadable: false, verdict: regressions > 0 ? "fail" : "pass", repos: reports.map((x) => x.repo), replayed: reports.reduce((t, x) => t + x.replayed, 0), regressions, mutants: reports.reduce((t, x) => t + x.mutants.length, 0) };
}

/** Pure read. A file that cannot be read or parsed is listed as unreadable, never skipped. */
export function listReports(dataDir: string | null, now = Date.now()): EvalsState {
  if (dataDir === null) return { generatedAt: now, runs: [] };
  const dir = reportsDir(dataDir);
  if (!fs.existsSync(dir)) return { generatedAt: now, runs: [] };
  const runs: RunSummary[] = [];
  for (const f of fs.readdirSync(dir)) {
    const m = FILE_RE.exec(f);
    if (!m) continue;
    const kind = m[1] as ReportKind;
    const savedAt = Number(m[2]);
    try {
      runs.push(summarize(f, kind, savedAt, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))));
    } catch (e) {
      runs.push({ file: f, kind, savedAt, unreadable: true, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { generatedAt: now, runs: runs.sort((a, b) => b.savedAt - a.savedAt) };
}
