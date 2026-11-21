import type { Blocker } from "./blockers.js";
import type { ReviewFinding, ReviewRecord, ThreadRecord } from "../ledger/schema.js";

export const RECAP_MARKER = "<!-- archangel:recap -->";

export function renderRecapComment(input: {
  thread: ThreadRecord;
  reviews: ReviewRecord[];
  blockers: Blocker[];
  wouldMerge?: boolean;
  summary?: string;
}): string {
  const { thread, reviews, blockers } = input;
  const lines: string[] = [
    RECAP_MARKER,
    `### Archangel Recap — Thread #${thread.issueNumber}`,
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| **State** | \`${thread.state}\` |`,
    `| **Branch** | \`${thread.branchName}\` |`,
    `| **Head SHA** | \`${thread.headSha ? thread.headSha.slice(0, 10) : "none"}\` |`,
    `| **Attempts** | implement: ${thread.implementCount}, revision: ${thread.revisionCount}, rebase: ${thread.rebaseCount} |`,
  ];

  if (thread.themeLabel) {
    lines.push(`| **Theme** | \`${thread.themeLabel}\` |`);
  }
  if (thread.postHandoff) {
    lines.push(`| **Mode** | Post-Handoff (advisory only — owner merges) |`);
  }
  if (input.wouldMerge) {
    lines.push("", "> **Shadow Mode verdict:** `WOULD MERGE` — all mechanical gates and independent reviews passed. Merge manually, or add `factory:disagree` if you would not have merged this PR.");
  }
  if (thread.needsYouReason) {
    lines.push("", `> **Needs You:** ${thread.needsYouReason}`);
  }
  if (input.summary) {
    lines.push("", "#### Latest Summary", input.summary);
  }

  if (reviews.length > 0) {
    lines.push("", "#### Independent Reviews");
    for (const r of reviews) {
      const findings = parseFindings(r.findingsJson);
      lines.push(`- **${r.vendor}** on \`${r.headSha.slice(0, 8)}\`: **${r.verdict.toUpperCase()}** (${findings.length} findings)`);
      for (const f of findings) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        lines.push(`  - [${f.severity}] \`${loc}\`: ${f.summary}`);
      }
    }
  }

  if (blockers.length > 0) {
    lines.push("", "#### Current Blockers");
    for (const b of blockers) {
      lines.push(`- \`${b.code}\`: ${b.message}`);
    }
  } else {
    lines.push("", "#### Current Blockers", "- None — eligible to land.");
  }

  return lines.join("\n");
}

function parseFindings(json: string): ReviewFinding[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ReviewFinding[]) : [];
  } catch {
    return [];
  }
}
