import type { Ledger } from "../ledger/store.js";
import { describeEscalation, formatDecisionClass } from "./escalations.js";
import type { Phase } from "./thread-machine.js";

export const STAGES = [
  "Working",
  "Waiting on CI",
  "In review",
  "Ready for owner",
  "Needs you",
  "Owner driving",
  "Queued",
  "Done in last 7 days",
] as const;
export type Stage = (typeof STAGES)[number];

export interface UiItem {
  repo: string;
  issueNumber: number;
  prNumber: number | null;
  title: string;
  phase: string;
  since: number;
}

export interface UiState {
  generatedAt: number;
  needsYou: Array<UiItem & { decisionClass: string; recommendation: string }>;
  stages: Record<Stage, UiItem[]>;
  outcomes: ReturnType<Ledger["computeMetrics"]>["outcomes"];
  autonomySteps: Record<string, number>;
  /** Last 14 local days, oldest first. */
  daily: Array<{ day: string; merged: number; reworkAttempts: number }>;
  scouts: Array<{ repo: string; issueNumber: number; scoutName: string; autoPromoted: boolean; hasThread: boolean; createdAt: number }>;
}

const DAY_MS = 86_400_000;

function stageOf(phase: Phase, updatedAt: number, now: number): Stage | null {
  switch (phase.kind) {
    case "working":
      return "Working";
    case "awaiting_gate":
      return "Waiting on CI";
    case "reviewing":
    case "landing":
      return "In review";
    case "shadow_ready":
      return "Ready for owner";
    case "needs_you":
      return "Needs you";
    case "owner_driving":
      return "Owner driving";
    case "queued":
      return "Queued";
    case "done":
      return now - updatedAt <= 7 * DAY_MS ? "Done in last 7 days" : null;
  }
}

function prOf(phase: Phase): number | null {
  return "prNumber" in phase && typeof phase.prNumber === "number" ? phase.prNumber : null;
}

/** Pure read of the Ledger into the dashboard's data. Never writes; makes no network calls. */
export function buildUiState(ledger: Ledger, now = Date.now()): UiState {
  const threads = ledger.listAllThreads();
  const stages = Object.fromEntries(STAGES.map((s) => [s, [] as UiItem[]])) as Record<Stage, UiItem[]>;
  const needsYou: UiState["needsYou"] = [];
  for (const t of threads) {
    const item: UiItem = {
      repo: t.repo,
      issueNumber: t.issueNumber,
      prNumber: prOf(t.phase),
      title: t.title,
      phase: t.phase.kind,
      since: t.updatedAt,
    };
    const stage = stageOf(t.phase, t.updatedAt, now);
    if (stage) stages[stage].push(item);
    if (t.phase.kind === "needs_you") {
      const p = describeEscalation(t.phase.code);
      needsYou.push({ ...item, decisionClass: formatDecisionClass(p.decisionClass), recommendation: p.recommendation });
    }
  }
  for (const list of Object.values(stages)) list.sort((a, b) => b.since - a.since);
  needsYou.sort((a, b) => a.since - b.since);
  const repos = [...new Set(threads.map((t) => t.repo))];
  const known = new Set(threads.map((t) => `${t.repo}#${t.issueNumber}`));
  return {
    generatedAt: now,
    needsYou,
    stages,
    outcomes: ledger.computeMetrics({ now }).outcomes,
    daily: ledger.dailyOutcomes(14, now),
    autonomySteps: Object.fromEntries(repos.map((r) => [r, ledger.autonomousStepsSinceOwner(r)])),
    scouts: ledger.listScoutProposals(25).map((p) => ({
      repo: p.repo,
      issueNumber: p.issueNumber,
      scoutName: p.scoutName,
      autoPromoted: p.autoPromoted,
      hasThread: known.has(`${p.repo}#${p.issueNumber}`),
      createdAt: p.createdAt,
    })),
  };
}
