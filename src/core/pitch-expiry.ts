import type { ArchangelConfig } from "../config.js";
import type { GitHubClient } from "../github/client.js";
import type { Ledger } from "../ledger/store.js";

/** An open pitch nobody decided in this many days is closed by the bot. */
export const PITCH_EXPIRY_DAYS = 14;
const DECLINE_REASON_MAX = 600;

/**
 * A pitch whose issue was closed is declined; the owner's own comments on it (their reason) feed the next Scout prompt.
 * Shared by the pitch Scout run and the per-tick housekeeping below.
 */
export async function syncPitchDecisions(
  ledger: Ledger,
  github: Pick<GitHubClient, "listOpenIssuesByLabel" | "listOwnerCommentsSince">,
  config: Pick<ArchangelConfig, "labels" | "ownerUserId">,
  now: number,
  log: (event: string, msg: string) => void = () => undefined,
): Promise<number[]> {
  const open = await github.listOpenIssuesByLabel(config.labels.agentPitch);
  const declined = ledger.syncPitchStatuses(open.map((i) => i.number), now);
  for (const d of declined) {
    try {
      const reason = (await github.listOwnerCommentsSince(d.issueNumber, config.ownerUserId, d.filedAt)).join("\n---\n").slice(0, DECLINE_REASON_MAX);
      if (reason) ledger.setPitchDeclineReason(d.issueNumber, reason);
    } catch (err) {
      // The reason is a hint for the prompt; the pitch is already declined without it, but say it was lost.
      log("pitch/decline_reason_failed", `#${d.issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return declined.map((d) => d.issueNumber);
}

/**
 * Closes open pitches older than PITCH_EXPIRY_DAYS that the owner never acted on (no owner comment since it was filed),
 * with a short comment, and marks them expired. An expired pitch counts as not promoted for the Scout's pause rule.
 * Close first: if closing fails nothing is recorded and the next tick retries; the comment is best effort once it is closed.
 */
export async function expireStalePitches(
  ledger: Ledger,
  github: Pick<GitHubClient, "listOpenIssuesByLabel" | "listOwnerCommentsSince" | "closeIssue" | "postComment">,
  config: Pick<ArchangelConfig, "labels" | "ownerUserId">,
  now: number,
  log: (event: string, msg: string) => void = () => undefined,
): Promise<number[]> {
  const stale = ledger.listOpenPitchesFiledBefore(now - PITCH_EXPIRY_DAYS * 86_400_000);
  if (stale.length === 0) return [];
  const stillOpen = new Set((await github.listOpenIssuesByLabel(config.labels.agentPitch)).map((i) => i.number));
  const expired: number[] = [];
  for (const p of stale) {
    if (!stillOpen.has(p.issueNumber)) continue; // closed some other way: the decline sync records it
    try {
      if ((await github.listOwnerCommentsSince(p.issueNumber, config.ownerUserId, p.filedAt)).length > 0) continue; // the owner engaged
      await github.closeIssue(p.issueNumber);
    } catch (err) {
      // One pitch's failure must not block expiring the rest; nothing is recorded, so the next tick retries it.
      log("pitch/expiry_failed", `#${p.issueNumber}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    ledger.markPitchExpired(p.issueNumber, now);
    ledger.appendAudit("pitch/expired", p.issueNumber, "archangel", { days: PITCH_EXPIRY_DAYS }, now);
    expired.push(p.issueNumber);
    try {
      await github.postComment(p.issueNumber, `Closing: no decision on this pitch in ${PITCH_EXPIRY_DAYS} days. It is recorded as expired and counts as not promoted. Reopen or file an issue yourself if you still want it.`);
    } catch (err) {
      log("pitch/expiry_comment_failed", err instanceof Error ? err.message : String(err));
    }
  }
  return expired;
}
