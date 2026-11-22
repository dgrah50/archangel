import type { EscalationCode } from "./thread-machine.js";

/**
 * Measurement and auto-off for factory retries (docs/AUTONOMOUS-ESCALATIONS.md 3.5 and 3.6, E5). Outcomes come from Ledger
 * mechanics and the owner's own actions only; no model labels anything and no free text is stored.
 */

export const FACTORY_OUTCOMES = ["success", "re_escalated", "owner_overrode", "bad", "pending"] as const;
export type FactoryOutcome = (typeof FACTORY_OUTCOMES)[number];

/** PROVISIONAL, a guess to tune from real data: look at this many of the most recent settled retries... */
export const FACTORY_AUTO_OFF_WINDOW = 5;
/** ...and switch the repo's factory retry off when this many of them ended unmerged (anything but success). */
export const FACTORY_AUTO_OFF_UNMERGED = 3;

export interface FactoryRetryFacts {
  /** The Thread's phase now: `done` with an outcome, or any other kind. */
  phaseKind: string;
  doneOutcome: string | null;
  /** A merge of this Thread turned main red, or the Thread ended `reverted`. */
  reverted: boolean;
  /** The owner marked a merge of this Thread `factory:disagree`. */
  disputed: boolean;
  /** An owner-actor audit row (reply, retry, close, handoff) exists after the retry. */
  ownerActedAfter: boolean;
  /** The Thread entered Needs You again after the retry. */
  escalatedAfter: boolean;
}

/** Order matters: damage first, then the owner stepping in, then a second escalation, then a clean merge. */
export function classifyFactoryOutcome(f: FactoryRetryFacts): FactoryOutcome {
  if (f.reverted || f.disputed) return "bad";
  if (f.ownerActedAfter || (f.phaseKind === "done" && f.doneOutcome !== "merged" && f.doneOutcome !== "owner_merged")) return "owner_overrode";
  if (f.escalatedAfter) return "re_escalated";
  if (f.phaseKind === "done") return "success";
  return "pending";
}

export interface SettledRetry {
  outcome: FactoryOutcome;
}

/** True when the repo's recent factory retries say it should stop: 3 of the last 5 unmerged, or any reverted or disputed. */
export function shouldAutoOff(retriesOldestFirst: readonly SettledRetry[]): { off: boolean; why: string } {
  const settled = retriesOldestFirst.filter((r) => r.outcome !== "pending");
  const bad = settled.filter((r) => r.outcome === "bad").length;
  if (bad > 0) return { off: true, why: `${bad} factory retr${bad === 1 ? "y was" : "ies were"} reverted or disputed` };
  const recent = settled.slice(-FACTORY_AUTO_OFF_WINDOW);
  const unmerged = recent.filter((r) => r.outcome !== "success").length;
  if (unmerged >= FACTORY_AUTO_OFF_UNMERGED) {
    return { off: true, why: `${unmerged} of the last ${recent.length} factory retries ended unmerged` };
  }
  return { off: false, why: "" };
}

export interface FactoryRetryOutcome {
  /** audit_log id of the `factory/retry` row. */
  auditId: number;
  issueNumber: number;
  code: EscalationCode;
  at: number;
  outcome: FactoryOutcome;
}
