import type { Blocker } from "./blockers.js";
import { describeEscalation, formatDecisionClass } from "./escalations.js";
import { workClassOfBranch } from "./work-class.js";
import { extractPrFromPhase } from "./thread-machine.js";
import { tailOutput, type GateProof } from "../gate/gate.js";
import type { ReviewFinding, ReviewRecord, ThreadRecord } from "../ledger/schema.js";

export const RECAP_MARKER = "<!-- archangel:recap -->";

export function renderRecapComment(input: {
  thread: ThreadRecord;
  reviews: ReviewRecord[];
  blockers: Blocker[];
  wouldMerge?: boolean;
  summary?: string | null;
  /** Gate reproduction-test output for the current head SHA; null/undefined when not captured. */
  gateProof?: GateProof | null;
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
  if (workClassOfBranch(thread.branchName) === "feature") {
    lines.push(`| **Class** | \`feature\` |`, `| **Landing** | Feature: owner merges |`);
  } else if (thread.mode === "advisory") {
    lines.push(`| **Landing** | Advisory only — owner merges manually |`);
  }
  if (input.wouldMerge) {
    lines.push(
      "",
      "> **Shadow Mode verdict:** `WOULD MERGE` — all mechanical gates and independent reviews passed. Merge manually, or add `factory:disagree` if you would not have merged this PR.",
    );
  }
  if (thread.phase.kind === "needs_you") {
    const policy = describeEscalation(thread.phase.code, workClassOfBranch(thread.branchName));
    lines.push(
      "",
      `> **Needs You — ${formatDecisionClass(policy.decisionClass)}** (\`${thread.phase.code}\`): ${thread.phase.reason}`,
      `> **Recommended:** ${policy.recommendation}`,
    );
  }
  const summaryText = input.summary ?? thread.lastSummary;
  if (summaryText) {
    lines.push("", "#### Latest Summary", summaryText);
    const assumptions = extractAssumptions(summaryText);
    lines.push("", "#### Implementer Assumptions", "_Decisions made without asking, quoted from the implementer's summary as plain text._", "");
    lines.push(...(assumptions === null ? ["_none stated_"] : fencedText(assumptions)));
  }

  lines.push(
    "",
    "#### Reproduction Test Proof",
    "_Machine output from the Gate run, shown verbatim (last lines only); not written by Archangel._",
    "",
    "**On base (expected to fail):**",
    ...(workClassOfBranch(thread.branchName) === "feature"
      ? ["_not applicable: feature Threads add tests for new behaviour, with no red-on-base proof_"]
      : fencedOutput(input.gateProof?.base_output)),
    "",
    "**On head (expected to pass):**",
    ...fencedOutput(input.gateProof?.head_output),
  );

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

/** The lines under an `Assumptions:` heading in the implementer summary, or null when there are none to show. */
export function extractAssumptions(summary: string): string | null {
  const lines = summary.split("\n");
  const start = lines.findIndex((l) => /^\s*(?:[#*_\s]*)assumptions\s*:?\s*(?:[*_]*)\s*:?\s*(.*)$/i.test(l));
  if (start === -1) return null;
  const inline = /^\s*(?:[#*_\s]*)assumptions\s*:?\s*(?:[*_]*)\s*:?\s*(.*)$/i.exec(lines[start]!)![1]!.trim();
  const body: string[] = inline ? [inline] : [];
  for (const l of lines.slice(start + 1)) {
    if (!l.trim() && body.length > 0) break;
    if (/^\s*#{1,6}\s/.test(l)) break;
    if (l.trim()) body.push(l.trimEnd());
  }
  const text = body.join("\n").slice(0, 1_500).trim();
  return !text || /^none\.?$/i.test(text) ? null : text;
}

function fencedText(text: string): string[] {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence + "text", text, fence];
}

function fencedOutput(output: string | undefined): string[] {
  if (output === undefined) return ["_not captured_"];
  if (!output.trim()) return ["_test command ran and printed nothing_"];
  const text = tailOutput(output);
  // Fence longer than any backtick run in the output so it cannot close the block early.
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence + "text", text, fence];
}

function parseFindings(json: string): ReviewFinding[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ReviewFinding[]) : [];
  } catch {
    return [];
  }
}
