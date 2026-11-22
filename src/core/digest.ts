import { describeEscalation, formatDecisionClass } from "./escalations.js";
import type { EscalationCode } from "./thread-machine.js";

export interface DigestInput {
  now: number;
  /** All configured projects, not one repo. */
  needsYou: Array<{ repo: string; issueNumber: number; title: string; code: EscalationCode; since: number }>;
  yesterday: { autonomousMerges: number; ownerMerges: number; reverts: number; spendUsd: number };
  /** Scout proposals still awaiting the owner (no Thread yet). */
  proposals: Array<{ repo: string; issueNumber: number; scoutName: string }>;
}

function age(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Plain-text daily digest, or null when there is nothing to say (no Needs You and a quiet yesterday). */
export function buildDigest(input: DigestInput): string | null {
  const y = input.yesterday;
  if (input.needsYou.length === 0 && y.autonomousMerges + y.ownerMerges + y.reverts === 0 && y.spendUsd === 0) {
    return null;
  }
  const lines = ["Archangel daily digest"];
  if (input.needsYou.length > 0) {
    lines.push("", `Needs You (${input.needsYou.length}):`);
    for (const n of input.needsYou) {
      const p = describeEscalation(n.code);
      lines.push(`${n.repo}#${n.issueNumber} ${n.title}`);
      lines.push(`  ${formatDecisionClass(p.decisionClass)}, waiting ${age(input.now - n.since)}`);
      lines.push(`  Recommended: ${p.recommendation}`);
    }
  }
  lines.push(
    "",
    "Yesterday:",
    `  Merges: ${y.autonomousMerges} autonomous, ${y.ownerMerges} owner`,
    `  Reverts (red main): ${y.reverts}`,
    `  Metered spend: $${y.spendUsd.toFixed(2)}`,
  );
  if (input.proposals.length > 0) {
    lines.push("", `Scout proposals awaiting you (${input.proposals.length}):`);
    for (const p of input.proposals) lines.push(`  ${p.repo}#${p.issueNumber} (${p.scoutName})`);
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
  opts: { now: number; timeZone: string; digestHour: number },
): Promise<boolean> {
  if (localHour(opts.now, opts.timeZone) < opts.digestHour) return false;
  const today = ledger.dayKeyOf(opts.now);
  if (ledger.digestSentFor(today)) return false;
  const text = buildDigest(ledger.collectDigestInput(opts.now));
  if (text === null) return false;
  await notifier.sendDigest(text);
  ledger.markDigestSent(today, opts.now);
  return true;
}
