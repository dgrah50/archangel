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
  const parts = await input.github.listOwnerCommentsSince(input.issueNumber, input.ownerUserId, input.sinceMs);
  if (input.prNumber && input.prNumber !== input.issueNumber) {
    parts.push(...(await input.github.listOwnerCommentsSince(input.prNumber, input.ownerUserId, input.sinceMs)));
  }
  if (input.message && input.message.trim()) {
    parts.push(input.message.trim());
  }
  return parts.length > 0 ? parts.join("\n\n---\n\n") : null;
}
