import type { Blocker } from "./blockers.js";
import { describeEscalation, formatDecisionClass } from "./escalations.js";
import { tryParseJson } from "./json.js";
import { workClassOfBranch } from "./work-class.js";
import { extractPrFromPhase } from "./thread-machine.js";
import { tailOutput, type GateProof } from "../gate/gate.js";
import { renderChaptersSection, type Chapter } from "./recap-chapters.js";
import { scanForSecrets, withholdSecrets } from "./secrets.js";
import { renderShotImages, type ShotLink } from "./pr-shots.js";
import type { ReviewFinding, ReviewRecord, ThreadRecord, TriageSummary } from "../ledger/schema.js";

export const RECAP_MARKER = "<!-- archangel:recap -->";

export function renderRecapComment(input: {
  thread: ThreadRecord;
  reviews: ReviewRecord[];
  blockers: Blocker[];
  wouldMerge?: boolean;
  summary?: string | null;
  /** Gate reproduction-test output for the current head SHA; null/undefined when not captured. */
  gateProof?: GateProof | null;
  /** Why the proof could not be read (a GitHub error): shown as "Gate proof unavailable", distinct from a Gate run that emitted no proof. */
  gateProofError?: string | null;
  /** What machine triage decided for this Thread (a `factory/triage` audit row); null/undefined when triage never ran. */
  triage?: TriageSummary | null;
  /** Feature PRs only: the diff grouped by area, with optional machine captions. */
  chapters?: Chapter[] | null;
  /** Small screenshots of the PR head, already published by the host; rendered as a short section. */
  shots?: ShotLink[];
  /** Called with the pattern name when agent-authored text was withheld for matching the secret scan. */
  onWithheld?: (pattern: string) => void;
}): string {
  const safe = (text: string): string => withholdSecrets(text, input.onWithheld);
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
  const workClass = workClassOfBranch(thread.branchName);
  if (workClass !== "bugfix") {
    lines.push(`| **Class** | \`${workClass}\` |`, `| **Landing** | ${workClass === "feature" ? "Feature" : "Chore"}: owner merges |`);
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
    const policy = describeEscalation(thread.phase.code, workClassOfBranch(thread.branchName), thread.phase.cause);
    lines.push(
      "",
      `> **Needs You — ${formatDecisionClass(policy.decisionClass)}** (\`${thread.phase.code}\`): ${safe(thread.phase.reason)}`,
      `> **Recommended:** ${policy.recommendation}`,
    );
  }
  if (input.triage) {
    const t = input.triage;
    lines.push(
      "",
      "#### Machine triage (factory), not the owner",
      `Vendor: ${t.vendor}. Decision: ${t.action === "guidance" ? "guidance" : "escalated"}. Cause: ${t.cause}.`,
    );
    if (t.action === "guidance" && t.steps.length > 0) lines.push("", ...fencedText(t.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")));
    else if (t.action === "escalate" && t.reason) lines.push("", ...fencedText(t.reason));
  }
  lines.push(...renderChaptersSection(input.chapters ?? []));
  const rawSummary = input.summary ?? thread.lastSummary;
  if (rawSummary) {
    const summaryText = safe(rawSummary);
    lines.push("", "#### Latest Summary", summaryText);
    const assumptions = extractAssumptions(summaryText);
    lines.push("", "#### Implementer Assumptions", "_Decisions made without asking, quoted from the implementer's summary as plain text._", "");
    lines.push(...(assumptions === null ? ["_none stated_"] : fencedText(assumptions)));
  }

  if (input.shots && input.shots.length > 0) {
    lines.push("", "#### Screenshots", "_Taken by Archangel from a sandboxed run of this head. The images are host-built links to the `archangel/assets` branch._", "", renderShotImages(input.shots));
  }

  const unavailable = input.gateProof ? null : (input.gateProofError ?? null);
  const proofBlock = (output: string | undefined): string[] =>
    unavailable !== null ? [`_Gate proof unavailable: ${unavailable.replace(/[\r\n`]+/g, " ").trim().slice(0, 200)}_`] : fencedOutput(output);
  lines.push(
    "",
    "#### Reproduction Test Proof",
    "_Machine output from the Gate run, shown verbatim (last lines only); not written by Archangel._",
    "",
    "**On base (expected to fail):**",
    ...(workClassOfBranch(thread.branchName) !== "bugfix"
      ? ["_not applicable: feature and chore Threads need no new test, so there is no red-on-base proof_"]
      : proofBlock(input.gateProof?.base_output)),
    "",
    "**On head (expected to pass):**",
    ...proofBlock(input.gateProof?.head_output),
  );
  const junit = input.gateProof?.junit;
  if (junit) {
    lines.push(
      "",
      "**Test cases matched in the JUnit report** (from the new test files):",
      ...(junit.base_failed.length > 0 ? ["Failed on base:", ...fencedOutput(junit.base_failed.join("\n"))] : []),
      "Passed on head:",
      ...fencedOutput(junit.head_passed.join("\n")),
    );
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
        lines.push(`  - [${f.severity}] \`${loc}\`: ${safe(f.summary)}`);
      }
    }
  }

  if (blockers.length > 0) {
    lines.push("", "#### Current Blockers");
    for (const b of blockers) {
      lines.push(`- \`${b.code}\`: ${safe(b.message)}`);
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
  // Test output is written by agent-authored tests: strip ANSI and control characters, and never publish a credential-shaped match.
  const text = tailOutput(
    output
      .replace(/\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""),
  );
  if (scanForSecrets(text) !== null) return ["_output withheld: it matched the secret scan_"];
  // Fence longer than any backtick run in the output so it cannot close the block early.
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [fence + "text", text, fence];
}

function parseFindings(json: string): ReviewFinding[] {
  const parsed = tryParseJson(json);
  return parsed.ok && Array.isArray(parsed.value) ? (parsed.value as ReviewFinding[]) : [];
}
