export const COMMAND_LINE_RE = /^\s*\/archangel(\s|$)/i;

/**
 * Collects the owner's reply to a Needs You escalation: owner-authored comments on the
 * issue and its PR posted after the escalation, plus an optional `archangel retry --message`.
 * Only comments whose author id equals `ownerUserId` count.
 */
export async function collectOwnerReply(input: {
  github: { listOwnerCommentsSince(n: number, ownerUserId: number, sinceMs: number): Promise<string[]> };
  ownerUserId: number;
  issueNumber: number;
  prNumber: number | null;
  sinceMs: number;
  message?: string | null;
}): Promise<string | null> {
  const raw = await input.github.listOwnerCommentsSince(input.issueNumber, input.ownerUserId, input.sinceMs);
  if (input.prNumber && input.prNumber !== input.issueNumber) {
    raw.push(...(await input.github.listOwnerCommentsSince(input.prNumber, input.ownerUserId, input.sinceMs)));
  }
  // A `/archangel <command>` first line is a command, not guidance for the next Attempt.
  const parts = raw
    .map((body) => (COMMAND_LINE_RE.test(body.split("\n")[0]!) ? body.split("\n").slice(1).join("\n").trim() : body))
    .filter(Boolean);
  if (input.message && input.message.trim()) {
    parts.push(input.message.trim());
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
}
