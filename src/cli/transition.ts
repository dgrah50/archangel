import type { ThreadRecord } from "../ledger/schema.js";

/**
 * `Ledger.transition` returns null when another writer changed the Thread first (compare-and-set). An owner command must say so,
 * not print success for a change that did not happen.
 */
export function requireTransition(updated: ThreadRecord | null, repoSlug: string, issueNumber: number): ThreadRecord {
  if (updated === null) {
    throw new Error(`${repoSlug}#${issueNumber} changed while this command ran, so nothing was changed; check \`archangel status\` and run it again.`);
  }
  return updated;
}
