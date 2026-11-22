import { describeEscalation, formatDecisionClass } from "./escalations.js";
import type { EscalationCode } from "./thread-machine.js";

export interface DigestInput {
  now: number;
  /** All configured projects, not one repo. */
  /** null = could not be read ("unavailable"), distinct from an empty list. */
  needsYou: Array<{ repo: string; issueNumber: number; title: string; code: EscalationCode; since: number }> | null;
  /** Each figure is null when it could not be computed ("unavailable"), distinct from a real 0. */
  yesterday: { autonomousMerges: number | null; ownerMerges: number | null; reverts: number | null; spendUsd: number | null };
  /** Scout proposals still awaiting the owner (no Thread yet); null = could not be read. */
  proposals: Array<{ repo: string; issueNumber: number; scoutName: string }> | null;
  /** Pitches awaiting the owner's decision (they expire after 14 days); null = could not be read. */
  pitches: Array<{ repo: string; issueNumber: number; scoutName: string; since: number }> | null;
  /** Subsystem error classes survived in the last 24h; null = could not be read. */
  faults: Array<{ repo: string; category: string; recent24h: number; lastError: string }> | null;
  /** Merged correction-loop drafts whose targeted category did not drop within 30 days of the merge: candidates to revert; null = could not be read. */
  draftReverts: Array<{ repo: string; category: string; url: string; before: number; after: number }> | null;
}

const UNAVAILABLE = "unavailable";

function age(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * Plain-text daily digest, or null when there is nothing to say: Needs You, pitches and proposals are all known to be
 * empty and every figure of yesterday is a known zero. Anything that could not be read (null) is never treated as empty,
 * and anything waiting on the owner (pitches, proposals) keeps the digest alive.
 */
export function buildDigest(input: DigestInput): string | null {
  const y = input.yesterday;
  if (
    input.needsYou?.length === 0 &&
    input.pitches?.length === 0 &&
    input.proposals?.length === 0 &&
    input.faults?.length === 0 &&
    input.draftReverts?.length === 0 &&
    y.autonomousMerges === 0 && y.ownerMerges === 0 && y.reverts === 0 &&
    y.spendUsd === 0
  ) {
    return null;
  }
  const n = (v: number | null) => (v === null ? UNAVAILABLE : String(v));
  const lines = ["Archangel daily digest"];
  if (input.needsYou === null) {
    lines.push("", `Needs You: ${UNAVAILABLE}`);
  } else if (input.needsYou.length > 0) {
    lines.push("", `Needs You (${input.needsYou.length}):`);
    for (const item of input.needsYou) {
      const p = describeEscalation(item.code);
      lines.push(`${item.repo}#${item.issueNumber} ${item.title}`);
      lines.push(`  ${formatDecisionClass(p.decisionClass)}, waiting ${age(input.now - item.since)}`);
      lines.push(`  Recommended: ${p.recommendation}`);
    }
  }
  lines.push(
    "",
    "Yesterday:",
    `  Merges: ${n(y.autonomousMerges)} autonomous, ${n(y.ownerMerges)} owner`,
    `  Reverts (red main): ${n(y.reverts)}`,
    `  Metered spend: ${y.spendUsd === null ? UNAVAILABLE : `$${y.spendUsd.toFixed(2)}`}`,
  );
  if (input.proposals === null) {
    lines.push("", `Scout proposals awaiting you: ${UNAVAILABLE}`);
  } else if (input.proposals.length > 0) {
    lines.push("", `Scout proposals awaiting you (${input.proposals.length}):`);
    for (const p of input.proposals) lines.push(`  ${p.repo}#${p.issueNumber} (${p.scoutName})`);
  }
  if (input.pitches === null) {
    lines.push("", `Pitches awaiting you: ${UNAVAILABLE}`);
  } else if (input.pitches.length > 0) {
    lines.push("", `Pitches awaiting you (${input.pitches.length}; they close unanswered after 14 days):`);
    for (const p of input.pitches) lines.push(`  ${p.repo}#${p.issueNumber} (${p.scoutName}), open ${age(input.now - p.since)}`);
  }
  if (input.faults === null) {
    lines.push("", `Errors survived: ${UNAVAILABLE}`);
  } else if (input.faults.length > 0) {
    lines.push("", `Errors survived in the last 24h (${input.faults.length} classes):`);
    for (const f of input.faults) lines.push(`  ${f.repo} ${f.category} x${f.recent24h}: ${f.lastError.slice(0, 100)}`);
  }
  if (input.draftReverts === null) {
    lines.push("", `Correction drafts to review for revert: ${UNAVAILABLE}`);
  } else if (input.draftReverts.length > 0) {
    lines.push("", `Merged correction drafts that did not help (${input.draftReverts.length}); consider reverting:`);
    for (const d of input.draftReverts) lines.push(`  ${d.repo} ${d.category}: ${d.before} corrections before, ${d.after} in the 30 days after the merge. ${d.url}`);
  }
  return lines.join("\n");
}

/** Local hour (0-23) of `ts` in `timeZone`. */
export function localHour(ts: number, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(ts))
    .find((p) => p.type === "hour")?.value;
  return Number(h);
}

export interface DigestLedger {
  digestSentFor(dayKey: string): boolean;
  markDigestSent(dayKey: string, now: number): void;
  collectDigestInput(now: number): DigestInput;
  dayKeyOf(ts: number): string;
}

/** Sends at most one digest per local day, at or after `digestHour`. Returns true if a message was sent. */
export async function sendDigestIfDue(
  ledger: DigestLedger,
  notifier: { sendDigest(text: string): Promise<void> },
  opts: {
    now: number;
    timeZone: string;
    digestHour: number;
    /** `repo#issue` of every Scout proposal issue that is still open with the agent-proposed label. */
    openProposals: () => Promise<Set<string>>;
  },
): Promise<boolean> {
  if (localHour(opts.now, opts.timeZone) < opts.digestHour) return false;
  const today = ledger.dayKeyOf(opts.now);
  if (ledger.digestSentFor(today)) return false;
  const input = ledger.collectDigestInput(opts.now);
  if (input.proposals !== null) {
    try {
      const open = await opts.openProposals();
      input.proposals = input.proposals.filter((p) => open.has(`${p.repo}#${p.issueNumber}`));
    } catch (_err) {
      input.proposals = null; // GitHub read failed: say "unavailable", do not list stale proposals or pretend there are none
    }
  }
  const text = buildDigest(input);
  if (text === null) return false;
  await notifier.sendDigest(text);
  ledger.markDigestSent(today, opts.now);
  return true;
}
