import { EscalationCodeSchema, type EscalationCode } from "./thread-machine.js";
import type { ReviewFinding } from "../ledger/schema.js";

/**
 * Correction loop, counting half (ROADMAP L3). Code, not a model, counts how often the owner corrects the factory, in closed
 * categories: no free text from issues, errors, reviewers or comments is ever stored or shown.
 */

export const CORRECTION_WINDOW_DAYS = 30;
/**
 * A category that repeats this many times in the window raises one Needs You. PROVISIONAL, a guess: the roadmap said 3; we start at 2
 * so the loop produces signal early and tune it from what the owner actually does with the notifications.
 */
export const CORRECTION_REPEAT_THRESHOLD = 2;

const SEVERITIES = ["blocker", "major", "minor"] as const;

export interface CorrectionCounts {
  windowDays: number | null;
  /** Threads the owner merged although the last review of their head SHA vetoed. */
  vetoOverruled: number;
  /** Merges the owner marked `factory:disagree` (owner-applied only). */
  disagreements: number;
  /** Owner retries (a reply or a cleared `needs-you`), keyed by the escalation code that was being answered. */
  ownerRetriesByCode: Record<string, number>;
  /** Merges that turned main red. */
  reverts: number;
  /** Reviewer findings from vetoes, keyed `<severity>:<top-level directory>`. */
  findings: Record<string, number>;
  /** Factory retries that did not end well, keyed `<escalation code>:<outcome>` (re_escalated, owner_overrode, bad). */
  factoryRetries: Record<string, number>;
}

/** First path segment as a slug (`src/core/x.ts` -> `src`, `README.md` -> `.`), or `other` for anything that is not a plain repo path. */
export function topLevelDir(file: string): string {
  const parts = file.replace(/\\/g, "/").replace(/^\.\//, "").split("/");
  if (parts.length < 2) return /^[\w.-]{1,40}$/.test(file) ? "." : "other";
  const dir = parts[0]!.toLowerCase();
  return /^[a-z0-9._-]{1,30}$/.test(dir) && !/^\.+$/.test(dir) ? dir : "other";
}

/** `<severity>:<dir>`, or null for a finding whose severity is not one of the three. */
export function findingCategory(f: Pick<ReviewFinding, "severity" | "file">): string | null {
  return (SEVERITIES as readonly string[]).includes(f.severity) ? `${f.severity}:${topLevelDir(String(f.file ?? ""))}` : null;
}

export interface CorrectionCategory {
  /** Stable key used for dedupe, e.g. `owner_retry:gate_failed`, `finding:major:src`. */
  category: string;
  count: number;
}

const ESCALATION_CODES: readonly string[] = EscalationCodeSchema.options;

/** Every category with its count, from fixed keys only: unknown codes and malformed finding keys are dropped. */
export function correctionCategories(c: CorrectionCounts): CorrectionCategory[] {
  const out: CorrectionCategory[] = [
    { category: "veto_overruled", count: c.vetoOverruled },
    { category: "disagree", count: c.disagreements },
    { category: "revert", count: c.reverts },
  ];
  for (const [code, n] of Object.entries(c.ownerRetriesByCode)) {
    if (ESCALATION_CODES.includes(code)) out.push({ category: `owner_retry:${code as EscalationCode}`, count: n });
  }
  for (const [key, n] of Object.entries(c.findings)) {
    if (/^(blocker|major|minor):[a-z0-9._-]{1,30}$/.test(key)) out.push({ category: `finding:${key}`, count: n });
  }
  for (const [key, n] of Object.entries(c.factoryRetries)) {
    const [code, outcome, ...rest] = key.split(":");
    if (rest.length === 0 && ESCALATION_CODES.includes(code ?? "") && ["re_escalated", "owner_overrode", "bad"].includes(outcome ?? "")) {
      out.push({ category: `factory_retry:${code}:${outcome}`, count: n });
    }
  }
  return out;
}

export function repeatedCategories(c: CorrectionCounts, threshold = CORRECTION_REPEAT_THRESHOLD): CorrectionCategory[] {
  return correctionCategories(c).filter((x) => x.count >= threshold);
}
