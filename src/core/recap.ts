import type { Blocker } from "./blockers.js";
import { describeEscalation, formatDecisionClass } from "./escalations.js";
import { tryParseJson } from "./json.js";
import { workClassOfBranch } from "./work-class.js";
import { extractPrFromPhase } from "./thread-machine.js";
import { tailOutput, type GateProof } from "../gate/gate.js";
import { nowLine, renderChaptersSection, type Chapter } from "./recap-chapters.js";
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
  /** The owner-written issue body, for the Summary's Before line; omitted when it could not be read. */
  issueBody?: string | null;
  /** Called with the pattern name when agent-authored text was withheld for matching the secret scan. */
  onWithheld?: (pattern: string) => void;
}): string {
  const safe = (text: string): string => withholdSecrets(text, input.onWithheld);
  const { thread, reviews, blockers } = input;
  const pr = extractPrFromPhase(thread.phase);
  const headSha = pr?.headSha ?? ("headSha" in thread.phase ? thread.phase.headSha : null) ?? null;

  const workClass = workClassOfBranch(thread.branchName);
  const lines: string[] = [
    RECAP_MARKER,
    `### Archangel Recap — Thread #${thread.issueNumber}`,
    "",
    ...renderSummary(input, workClass),
  ];

  const table = [
    `| Field | Value |`,
    `|---|---|`,
    `| **Phase** | \`${thread.phase.kind}\` (v${thread.version}) |`,
    `| **Mode** | \`${thread.mode}\` |`,
    `| **Branch** | \`${thread.branchName}\` |`,
    `| **Head SHA** | \`${headSha ? headSha.slice(0, 10) : "none"}\` |`,
    `| **Attempts** | implement: ${thread.implementCount}, revision: ${thread.revisionCount}, rebase: ${thread.rebaseCount} |`,
  ];
  if (thread.themeLabel) table.push(`| **Theme** | \`${thread.themeLabel}\` |`);
  if (workClass !== "bugfix") {
    table.push(`| **Class** | \`${workClass}\` |`, `| **Landing** | ${workClass === "feature" ? "Feature" : "Chore"}: owner merges |`);
  } else if (thread.mode === "advisory") {
    table.push(`| **Landing** | Advisory only — owner merges manually |`);
  }
  lines.push(...details("Thread and Attempt history", table));

  if (input.wouldMerge) {
    lines.push(
      "",
      "> **Shadow Mode verdict:** `WOULD MERGE` — all mechanical gates and independent reviews passed. Merge manually, or add `factory:disagree` if you would not have merged this PR.",
    );
  }
  if (thread.phase.kind === "needs_you") {
    const policy = describeEscalation(thread.phase.code, workClass, thread.phase.cause);
    lines.push(
      "",
      `> **Needs You — ${formatDecisionClass(policy.decisionClass)}** (\`${thread.phase.code}\`): ${safe(thread.phase.reason)}`,
      `> **Recommended:** ${policy.recommendation}`,
    );
  }
  if (input.triage) {
    const t = input.triage;
    const body = [`Vendor: ${t.vendor}. Decision: ${t.action === "guidance" ? "guidance" : "escalated"}. Cause: ${t.cause}.`];
    if (t.action === "guidance" && t.steps.length > 0) body.push("", ...fencedText(t.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")));
    else if (t.action === "escalate" && t.reason) body.push("", ...fencedText(t.reason));
    lines.push(...details("Machine triage (factory), not the owner", body));
  }
  const chapterSection = renderChaptersSection(input.chapters ?? []);
  if (chapterSection.length > 0) lines.push(...details("Chapters with captions", chapterSection.slice(1)));
  const rawSummary = input.summary ?? thread.lastSummary;
  if (rawSummary) {
    const summaryText = safe(rawSummary);
    const assumptions = extractAssumptions(summaryText);
    lines.push(
      ...details("Latest Summary and Implementer Assumptions", [
        "#### Latest Summary",
        summaryText,
        "",
        "#### Implementer Assumptions",
        "_Decisions made without asking, quoted from the implementer's summary as plain text._",
        "",
        ...(assumptions === null ? ["_none stated_"] : fencedText(assumptions)),
      ]),
    );
  }

  const unavailable = input.gateProof ? null : (input.gateProofError ?? null);
  const proofBlock = (output: string | undefined): string[] =>
    unavailable !== null ? [`_Gate proof unavailable: ${unavailable.replace(/[\r\n`]+/g, " ").trim().slice(0, 200)}_`] : fencedOutput(output);
  const proof: string[] = [
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
  ];
  const junit = input.gateProof?.junit;
  if (junit) {
    proof.push(
      "",
      "**Test cases matched in the JUnit report** (from the new test files):",
      ...(junit.base_failed.length > 0 ? ["Failed on base:", ...fencedOutput(junit.base_failed.join("\n"))] : []),
      "Passed on head:",
      ...fencedOutput(junit.head_passed.join("\n")),
    );
  }
  lines.push(...details("Gate proof and reproduction output", proof));

  if (reviews.length > 0) {
    const revLines: string[] = [];
    for (const r of reviews) {
      const findings = parseFindings(r.findingsJson);
      revLines.push(
        `- **${r.vendor}** on \`${r.headSha.slice(0, 8)}\`: **${r.verdict.toUpperCase()}** (${findings.length} findings)`,
      );
      for (const f of findings) {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        revLines.push(`  - [${f.severity}] \`${loc}\`: ${safe(f.summary)}`);
      }
    }
    lines.push(...details("Independent Reviews", revLines));
  }

  lines.push(
    ...details(
      "Current Blockers",
      blockers.length > 0 ? blockers.map((b) => `- \`${b.code}\`: ${safe(b.message)}`) : ["- None — eligible to land."],
    ),
  );

  return lines.join("\n");
}

/** A collapsed section. The blank lines around the body are what make GitHub render markdown inside <details>. */
function details(title: string, body: string[]): string[] {
  return ["", "<details>", `<summary>${title}</summary>`, "", ...body, "", "</details>"];
}

/** One line of owner-written text, shown literally: markup characters are escaped, never dropped (so `f([1], 2)` stays readable); no newlines, secret-scanned, capped. */
function plainLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (scanForSecrets(t) !== null) return "_withheld: matched the secret scan_";
  return (t.length > max ? `${t.slice(0, max - 1)}…` : t).replace(/[\\`<>|[\]]/g, "\\$&");
}

const SECTION_START = /^\s*(?:#{1,6}\s*)?[*_]*(expected(?:\s+behaviou?r)?|repro(?:duction|\s+steps)?|steps\s+to\s+reproduce)[*_]*\s*:?/i;

/** The issue body's paragraphs before any Expected/Repro section, without code fences. */
function problemParagraphs(body: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const l of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced;
    else if (!fenced) {
      if (SECTION_START.test(l)) break;
      lines.push(l);
    }
  }
  return lines.join("\n").split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** The first complete sentences of the problem statement, up to about 300 characters, skipping lead-ins that end with ":". */
function problemSentences(body: string): string {
  const out: string[] = [];
  let len = 0;
  for (const sentence of problemParagraphs(body).flatMap((p) => p.split(/(?<=[.!?])\s+/))) {
    if (sentence.endsWith(":")) continue;
    if (out.length > 0 && len + sentence.length + 1 > 300) break;
    out.push(sentence);
    len += sentence.length + 1;
  }
  return out.join(" ");
}

/** The "Before" line from the issue the owner wrote, shared by the PR body and the Recap. */
export function beforeLine(issueNumber: number, title: string, body?: string | null): string {
  const problem = problemSentences(body ?? "");
  const detail = problem ? ` — ${plainLine(problem, 320)}` : "";
  return `**Before** (issue #${issueNumber}, owner-written): ${plainLine(title, 120)}${detail}`;
}

/** The owner's own "Expected:" line from the issue, or null when the issue has none. */
export function expectedLine(issueNumber: number, body?: string | null): string | null {
  const lines = (body ?? "").split("\n");
  const at = lines.findIndex((l) => /^\s*(?:#{1,6}\s*)?[*_]*expected(?:\s+behaviou?r)?[*_]*\s*:/i.test(l));
  if (at === -1) return null;
  const text = [lines[at]!.replace(/^[^:]*:[*_]*/, ""), ...lines.slice(at + 1)].join("\n").split(/\n\s*\n|\n\s*#/)[0]!.replace(/\s+/g, " ").trim();
  const first = plainLine(text.split(/(?<=[.!?])\s+/)[0] ?? "", 200);
  return first ? `**Expected** (issue #${issueNumber}, owner-written): ${first}` : null;
}

/** The PR body: the Summary the Recap later extends, then the closing keyword. */
export function renderPrBody(issue: { number: number; title: string; body?: string | null }, chapters: readonly Chapter[]): string {
  return [
    "### Summary",
    beforeLine(issue.number, issue.title, issue.body),
    expectedLine(issue.number, issue.body),
    nowLine(chapters),
    "",
    `Closes #${issue.number}`,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

/** What changed, one line per chapter (at most 6), from the mechanical chapters of a feature PR. */
function chapterLines(chapters: readonly Chapter[]): string[] {
  const shown = chapters.slice(0, 6).map((c) => `- ${c.area === "(root)" ? "Repo root" : `\`${c.area}/\``} (${c.kind}): ${c.files.length} file${c.files.length === 1 ? "" : "s"}, +${c.added}/−${c.deleted}`);
  if (chapters.length > 6) shown.push(`- ${chapters.length - 6} more areas`);
  return shown;
}

function renderSummary(input: Parameters<typeof renderRecapComment>[0], workClass: string): string[] {
  const { thread, reviews, blockers } = input;
  const out = ["#### Summary", beforeLine(thread.issueNumber, thread.title, input.issueBody)];
  const expected = expectedLine(thread.issueNumber, input.issueBody);
  if (expected) out.push(expected);
  const chapters = input.chapters ?? [];
  out.push(nowLine(chapters));
  if (workClass === "feature" && chapters.length > 0) {
    const added = chapters.reduce((n, c) => n + c.added, 0);
    const deleted = chapters.reduce((n, c) => n + c.deleted, 0);
    out.push("", `**What changed** (+${added}/−${deleted})`, ...chapterLines(chapters));
  }
  const judge: string[] = [];
  const protectedHit = blockers.find((b) => b.code === "protected_paths_touched");
  if (protectedHit) judge.push(`- Protected paths touched: ${protectedHit.message}`);
  if (thread.phase.kind === "needs_you") judge.push(`- Decision needed (\`${thread.phase.code}\`): see below`);
  if (blockers.some((b) => b.code === "review_vetoed")) judge.push("- A reviewer vetoed this head");
  if (workClass !== "bugfix") judge.push(`- ${workClass === "feature" ? "Feature" : "Chore"}: owner merges`);
  else if (thread.mode === "advisory") judge.push("- Advisory only: owner merges manually");
  if (judge.length > 0) out.push("", "**Needs your judgement**", ...judge);
  const facts: string[] = [];
  if (input.gateProof) facts.push(workClass === "bugfix" ? "Gate proof captured (new test on base and head)" : "Gate proof captured");
  if (reviews.length > 0) {
    const approved = reviews.filter((r) => r.verdict === "approve").length;
    facts.push(`${approved}/${reviews.length} reviews approve`);
  }
  facts.push(blockers.length === 0 ? "no blockers" : `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`);
  if (input.shots && input.shots.length > 0) out.push("", "**Screenshots** (taken by Archangel from a sandboxed run of this head)", renderShotImages(input.shots));
  out.push("", `**Verified:** ${facts.join(" · ")}`);
  return out;
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
