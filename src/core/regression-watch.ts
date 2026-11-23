import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Ledger } from "../ledger/store.js";
import { execFileGroup } from "./spawn-group.js";

/**
 * C2: regression watch per policy version. Outcomes are grouped by the (workflow file, implement prompt template) in force
 * when a Thread's first implement Attempt started. A group is flagged when its rework rate rose against the group before it,
 * or when any of its Threads was reverted. Arithmetic only: no model, no outside text.
 * All thresholds are PROVISIONAL first guesses, to be tuned against real data.
 */

/** Only groups whose first Attempt began this recently are flagged; older ones are history. */
export const REGRESSION_WINDOW_MS = 14 * 86_400_000;
/** A group needs at least this many Threads before its rework rate is compared. A revert flags regardless. */
export const REGRESSION_MIN_THREADS = 3;
/** The rework rate (Threads that needed a revision, over Threads) must rise by at least this much over the previous group. */
export const REGRESSION_MIN_RISE = 0.25;

export interface PolicyGroup {
  workflowSha: string;
  promptSha: string;
  firstAt: number;
  threads: number;
  rework: number;
  reverts: number;
}

export interface PolicyRegression {
  group: PolicyGroup;
  reworkRate: number;
  prevReworkRate: number;
}

const rate = (g: PolicyGroup): number => (g.threads === 0 ? 0 : g.rework / g.threads);

/** `groups` oldest first. Returns the groups in the window that regressed against their predecessor. */
export function detectPolicyRegressions(groups: PolicyGroup[], now: number): PolicyRegression[] {
  const out: PolicyRegression[] = [];
  for (let i = 1; i < groups.length; i++) {
    const g = groups[i]!;
    if (g.firstAt < now - REGRESSION_WINDOW_MS) continue;
    const prev = rate(groups[i - 1]!);
    const rose = g.threads >= REGRESSION_MIN_THREADS && rate(g) - prev >= REGRESSION_MIN_RISE;
    if (rose || g.reverts > 0) out.push({ group: g, reworkRate: rate(g), prevReworkRate: prev });
  }
  return out;
}

export function policyRegressions(ledger: Ledger, now: number): PolicyRegression[] {
  return detectPolicyRegressions(ledger.policyGroups(), now);
}

/**
 * The implement prompt templates are Archangel's own source, not the project's, so a prompt version has no commit in the
 * project. The hint is the latest commit of this checkout that touched them; null when this is not a git checkout.
 */
export async function archangelPromptCommit(): Promise<string | null> {
  try {
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const { stdout } = await execFileGroup("git", ["log", "-1", "--format=%h", "--", "src/agents/prompts.ts"], { cwd, timeout: 10_000 });
    return /^[0-9a-f]{7,40}$/.test(stdout.trim()) ? stdout.trim() : null;
  } catch (_err) {
    return null; // not a git checkout (or git is missing): the hint just has no commit
  }
}
