import type { Blocker } from "./blockers.js";
import { describeEscalation, formatDecisionClass } from "./escalations.js";
import { extractPrFromPhase } from "./thread-machine.js";
import type { ReviewFinding, ReviewRecord, ThreadRecord } from "../ledger/schema.js";

export const RECAP_MARKER = "<!-- archangel:recap -->";

export function renderRecapComment(input: {
  thread: ThreadRecord;
  reviews: ReviewRecord[];
  blockers: Blocker[];
  wouldMerge?: boolean;
  summary?: string | null;
}): string {
  const { thread, reviews, blockers } = input;
  const pr = extractPrFromPhase(thread.phase);
  const headSha = pr?.headSha ?? ("headSha" in thread.phase ? thread.phase.headSha : null) ?? null;

  const lines: string[] = [
    RECAP_MARKER,
    `### Archangel Recap — Thread #${thread.issueNumber}`,
    "",
    `| Field | Value |`,
    `|---|---|`,
    `| **Phase** | \`${thread.phase.kind}\` (v${thread.version}) |`,
    `| **Mode** | \`${thread.mode}\` |`,
    `| **Branch** | \`${thread.branchName}\` |`,
    `| **Head SHA** | \`${headSha ? headSha.slice(0, 10) : "none"}\` |`,
    `| **Attempts** | implement: ${thread.implementCount}, revision: ${thread.revisionCount}, rebase: ${thread.rebaseCount} |`,
  ];

  if (thread.themeLabel) {
    lines.push(`| **Theme** | \`${thread.themeLabel}\` |`);
  }
  if (thread.mode === "advisory") {
    lines.push(`| **Landing** | Advisory only — owner merges manually |`);
  }
  if (input.wouldMerge) {
    lines.push(
      "",
      "> **Shadow Mode verdict:** `WOULD MERGE` — all mechanical gates and independent reviews passed. Merge manually, or add `factory:disagree` if you would not have merged this PR.",
    );
  }
  if (thread.phase.kind === "needs_you") {
    const policy = describeEscalation(thread.phase.code);
    lines.push(
      "",
      `> **Needs You — ${formatDecisionClass(policy.decisionClass)}** (\`${thread.phase.code}\`): ${thread.phase.reason}`,
      `> **Recommended:** ${policy.recommendation}`,
    );
  }
  const summaryText = input.summary ?? thread.lastSummary;
  if (summaryText) {
    lines.push("", "#### Latest Summary", summaryText);
  }

  if (reviews.length > 0) {
    lines.push("", "#### Independent Reviews");
    for (const r of reviews) {
      const findings = parseFindings(r.findingsJson);
      lines.push(
        `- **${r.vendor}** on \`${r.headSha.slice(0, 8)}\`: **${r.verdict.toUpperCase()}** (${findings.length} findings)`,
      );
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
