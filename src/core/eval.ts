import crypto from "node:crypto";
import type { ReviewPromptBuilders, ReviewRequest, ReviewerSuite } from "../agents/reviewers.js";
import { REPO_POLICY_PATH } from "../config.js";
import { tryParseJson } from "./json.js";
import type { Ledger } from "../ledger/store.js";
import {
  MUTATORS,
  basePolicy,
  deriveCases,
  diffFiles,
  git,
  mutantCommit,
  openReplayClone,
  pinnedShas,
  show,
} from "./replay.js";
import { Workflow } from "./workflow.js";

/**
 * Offline review eval (V6): replays the REVIEW stage of captured Threads, once with the current reviewer wording and once with a
 * candidate's, and scores each verdict against a label that comes only from the Ledger (merged and undisputed = good; reverted,
 * disagreed, red main or owner-closed = bad) or from a deterministic seeded corruption (bad). The verdict against the label is
 * the only score: no model grades another model. It never changes anything; it only produces a report. Landing a prompt, rubric
 * or skill change always needs the owner's merge.
 */

/**
 * PROVISIONAL thresholds: educated guesses, not calibrated against real data. Recalibrate when the vault reaches 20 and again at
 * 40 replayable cases (see `milestones`); until then they are deliberately conservative.
 */
export const EVAL_THRESHOLDS = {
  /** Fewer scored cases than this prints INSUFFICIENT DATA and exits non-zero: a thin run must never read as a pass. */
  minCases: 8,
  /** A hard fail: the candidate approves a known-bad case that the baseline vetoed. */
  maxNewFalseApprovals: 0,
  /** New false vetoes allowed per 10 known-good cases scored (rounded down, so fewer than 10 good cases allow none). */
  maxNewFalseVetoesPer10Good: 1,
  /** Share of cases that go to the dev set; the rest are held out (owner disputes are always held out). */
  devShare: 0.6,
  /** Case counts at which these numbers should be revisited. */
  milestones: [20, 40] as readonly number[],
  /** Real model calls cost quota: cap the cases per run unless `--max-cases` says otherwise. */
  defaultMaxCases: 12,
} as const;

/** The seeded corruptions that are about what a reviewer reads (tests and fixes), not about what only the Gate can see. */
export const EVAL_MUTATORS = ["revert-fix-keep-test", "weaken-test-assertion", "drop-new-tests", "edit-existing-test"] as const;

export type Split = "dev" | "heldout";
export interface EvalCase {
  id: string;
  repo: string;
  issueNumber: number;
  kind: "merged_fix" | "owner_closed" | "mutant";
  label: "good" | "bad";
  /** An owner dispute (disagreed, reverted, red main, owner-closed): permanently held out. */
  dispute: boolean;
  headSha: string;
  title: string;
  /** The issue text kept at intake; null for older Threads (the reviewer then only gets the title). */
  body: string | null;
  diffText: string;
  touchedFiles: Record<string, string>;
  rubric: string | undefined;
  mutator?: string;
  split: Split;
}

/** Deterministic split: a hash of the case id, never a random draw, so a case never changes side between runs. */
export function splitOf(caseId: string): Split {
  const n = crypto.createHash("sha256").update(caseId).digest().readUInt32BE(0) % 100;
  return n < EVAL_THRESHOLDS.devShare * 100 ? "dev" : "heldout";
}

export interface EvalSource {
  repo: string;
  bareRepoPath: string;
  seeds: ReturnType<Ledger["listReplaySeeds"]>;
}

const MAX_DIFF_CHARS = 40_000;

async function diffOf(dir: string, base: string, head: string): Promise<{ diffText: string; touchedFiles: Record<string, string> }> {
  const diffText = (await git(dir, ["diff", "--no-color", base, head])).slice(0, MAX_DIFF_CHARS);
  const files = (await git(dir, ["diff", "--name-only", base, head])).split("\n").filter(Boolean).slice(0, 10);
  const touchedFiles: Record<string, string> = {};
  for (const f of files) {
    const text = await show(dir, head, f);
    if (text !== null) touchedFiles[f] = text;
  }
  return { diffText, touchedFiles };
}

async function rubricAt(dir: string, base: string): Promise<string | undefined> {
  const raw = await show(dir, base, REPO_POLICY_PATH);
  if (raw === null) return undefined;
  const json = tryParseJson(raw);
  if (!json.ok) return undefined;
  const parsed = Workflow.safeParse(json.value);
  return parsed.success ? parsed.data.review.rubric : undefined;
}

/**
 * Builds the labelled cases from the Ledger seeds and each repo's pinned eval refs, records them in the vault (which fixes their
 * split), and returns them. A case is only replayable when its head is pinned and has a base to diff against.
 */
export async function collectEvalCases(ledger: Ledger, sources: EvalSource[], now = Date.now()): Promise<{ cases: EvalCase[]; skipped: number }> {
  const cases: EvalCase[] = [];
  let skipped = 0;
  for (const src of sources) {
    const clone = await openReplayClone(src.bareRepoPath);
    try {
      for (const c of deriveCases(src.seeds)) {
        if (c.kind === "rejected_attempt") continue; // the Gate rejects these before any reviewer sees them
        const seed = src.seeds.find((s) => s.issueNumber === c.issueNumber)!;
        if (!(await pinnedShas(clone.dir, src.repo, c.issueNumber)).has(c.headSha)) {
          skipped++;
          continue;
        }
        let base: string;
        try {
          base = (await git(clone.dir, ["merge-base", c.headSha, clone.mainRef])).trim();
        } catch (_err) {
          skipped++;
          continue;
        }
        if (base === c.headSha) {
          skipped++;
          continue;
        }
        const rubric = await rubricAt(clone.dir, base);
        const common = { repo: src.repo, issueNumber: c.issueNumber, title: seed.title, body: seed.issueBody, rubric };
        const real: Omit<EvalCase, "split"> = {
          ...common,
          id: `${src.repo}#${c.issueNumber}:${c.headSha.slice(0, 12)}`,
          kind: c.kind === "owner_closed" ? "owner_closed" : "merged_fix",
          label: c.label,
          dispute: c.label === "bad",
          headSha: c.headSha,
          ...(await diffOf(clone.dir, base, c.headSha)),
        };
        cases.push({ ...real, split: ledger.upsertEvalCase({ caseId: real.id, repo: real.repo, issueNumber: real.issueNumber, kind: real.kind, label: real.label, dispute: real.dispute, headSha: real.headSha }, splitOf, now) });

        // Seeded known-bad cases: a deterministic corruption of each known-good bugfix.
        if (c.label !== "good" || c.kind !== "merged_fix" || c.workClass !== "bugfix") continue;
        const pol = await basePolicy(clone.dir, base);
        if ("reason" in pol) continue;
        const diff = await diffFiles(clone.dir, base, c.headSha);
        for (const m of MUTATORS.filter((x) => (EVAL_MUTATORS as readonly string[]).includes(x.name))) {
          const edits = await m.build({ dir: clone.dir, base, head: c.headSha, policy: pol.policy, diff });
          if (!edits) continue;
          const mutant = await mutantCommit(clone.dir, base, c.headSha, edits);
          const mc: Omit<EvalCase, "split"> = {
            ...common,
            id: `${real.id}:${m.name}`,
            kind: "mutant",
            label: "bad",
            dispute: false,
            headSha: c.headSha,
            mutator: m.name,
            ...(await diffOf(clone.dir, base, mutant)),
          };
          cases.push({ ...mc, split: ledger.upsertEvalCase({ caseId: mc.id, repo: mc.repo, issueNumber: mc.issueNumber, kind: mc.kind, label: mc.label, dispute: false, headSha: mc.headSha }, splitOf, now) });
        }
      }
    } finally {
      clone.cleanup();
    }
  }
  return { cases, skipped };
}

/** One hash for everything that decides a verdict: both prompt templates (inputs blanked) and the rubric used. */
export function promptHashFor(prompts: ReviewPromptBuilders, rubric: string | undefined): string {
  const blank: ReviewRequest = { issueNumber: 0, title: "", body: "", headSha: "", diffText: "", touchedFiles: {}, reviewRubric: rubric };
  return crypto.createHash("sha256").update(`${prompts.contract(blank)}\n=====\n${prompts.adversarial(blank)}`, "utf8").digest("hex");
}

export type Arm = "baseline" | "candidate";
interface Verdicts {
  /** case id -> approve/veto; absent when the reviewers errored for that case. */
  byCase: Map<string, "approve" | "veto">;
  errors: number;
  cacheHits: number;
}

async function verdictsFor(
  ledger: Ledger,
  cases: EvalCase[],
  suite: ReviewerSuite,
  prompts: ReviewPromptBuilders,
  rubricOverride: string | null,
): Promise<Verdicts> {
  const out: Verdicts = { byCase: new Map(), errors: 0, cacheHits: 0 };
  for (const c of cases) {
    const rubric = rubricOverride ?? c.rubric;
    const key = promptHashFor(prompts, rubric);
    const cached = ledger.getEvalResult(key, c.id);
    if (cached) {
      out.byCase.set(c.id, cached.verdict);
      out.cacheHits++;
      continue;
    }
    try {
      const batch = await suite.reviewAll({
        issueNumber: c.issueNumber,
        title: c.title,
        body: c.body ?? c.title,
        headSha: c.headSha,
        diffText: c.diffText,
        touchedFiles: c.touchedFiles,
        reviewRubric: rubric,
      });
      // The quorum rule: a change lands only if every reviewer approves, so any veto is a veto. An outage is not a verdict.
      if (batch.errors.length > 0 || batch.results.length === 0) {
        out.errors++;
        continue;
      }
      const verdict = batch.results.every((r) => r.verdict === "approve") ? "approve" : "veto";
      ledger.putEvalResult(key, c.id, verdict, batch.results.map((r) => `${r.vendor}:${r.verdict}`).join(","));
      out.byCase.set(c.id, verdict);
    } catch (_err) {
      out.errors++;
    }
  }
  return out;
}

export interface EvalOptions {
  ledger: Ledger;
  sources: EvalSource[];
  /** Builds a reviewer suite that uses the given prompt templates (real CLIs in production, fakes in tests). */
  suiteFor: (prompts: ReviewPromptBuilders) => ReviewerSuite;
  baseline: ReviewPromptBuilders;
  candidate: { prompts: ReviewPromptBuilders; rubricOverride: string | null; patchSha256: string; files: string[]; touchesSkills: boolean };
  heldout?: boolean;
  maxCases?: number;
  now?: number;
}

export interface EvalReport {
  split: Split;
  candidate: { patchSha256: string; files: string[]; touchesSkills: boolean };
  counts: { total: number; dev: number; heldout: number; good: number; bad: number; disputes: number; mutants: number; unreplayable: number; withoutIssueText: number };
  milestones: { current: number; next: number | null };
  selected: number;
  scored: { good: number; bad: number };
  errors: number;
  cacheHits: number;
  baseline: { falseApprovals: string[]; falseVetoes: string[] };
  candidateArm: { falseApprovals: string[]; falseVetoes: string[] };
  newFalseApprovals: string[];
  newFalseVetoes: string[];
  fixedFalseApprovals: string[];
  fixedFalseVetoes: string[];
  allowedNewFalseVetoes: number;
  result: "pass" | "fail" | "insufficient";
  reasons: string[];
}

/** Picks up to `max` cases of the chosen split, alternating known-good and known-bad so a small cap still tests both. */
function select(cases: EvalCase[], max: number): EvalCase[] {
  const key = (c: EvalCase) => crypto.createHash("sha256").update(c.id).digest("hex");
  const good = cases.filter((c) => c.label === "good").sort((a, b) => key(a).localeCompare(key(b)));
  const bad = cases.filter((c) => c.label === "bad").sort((a, b) => key(a).localeCompare(key(b)));
  const picked: EvalCase[] = [];
  for (let i = 0; picked.length < max && (i < good.length || i < bad.length); i++) {
    if (bad[i] && picked.length < max) picked.push(bad[i]!);
    if (good[i] && picked.length < max) picked.push(good[i]!);
  }
  return picked;
}

export function milestoneProgress(replayable: number): { current: number; next: number | null } {
  return { current: replayable, next: EVAL_THRESHOLDS.milestones.find((m) => replayable < m) ?? null };
}

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const now = opts.now ?? Date.now();
  const { cases, skipped } = await collectEvalCases(opts.ledger, opts.sources, now);
  const split: Split = opts.heldout ? "heldout" : "dev";
  const chosen = select(cases.filter((c) => c.split === split), opts.maxCases ?? EVAL_THRESHOLDS.defaultMaxCases);

  const base = await verdictsFor(opts.ledger, chosen, opts.suiteFor(opts.baseline), opts.baseline, null);
  const cand = await verdictsFor(opts.ledger, chosen, opts.suiteFor(opts.candidate.prompts), opts.candidate.prompts, opts.candidate.rubricOverride);

  // Only cases both arms produced a verdict for are scored; an outage is never counted as an approval or a veto.
  const scored = chosen.filter((c) => base.byCase.has(c.id) && cand.byCase.has(c.id));
  const good = scored.filter((c) => c.label === "good");
  const bad = scored.filter((c) => c.label === "bad");
  const falseApprovals = (v: Verdicts) => bad.filter((c) => v.byCase.get(c.id) === "approve").map((c) => c.id);
  const falseVetoes = (v: Verdicts) => good.filter((c) => v.byCase.get(c.id) === "veto").map((c) => c.id);
  const bA = falseApprovals(base);
  const cA = falseApprovals(cand);
  const bV = falseVetoes(base);
  const cV = falseVetoes(cand);
  const allowedNewFalseVetoes = Math.floor(good.length / 10) * EVAL_THRESHOLDS.maxNewFalseVetoesPer10Good;
  const newFalseApprovals = cA.filter((id) => !bA.includes(id));
  const newFalseVetoes = cV.filter((id) => !bV.includes(id));

  const reasons: string[] = [];
  if (scored.length < EVAL_THRESHOLDS.minCases) reasons.push(`only ${scored.length} replayable ${split} case(s) scored; at least ${EVAL_THRESHOLDS.minCases} are required`);
  if (scored.length > 0 && (good.length === 0 || bad.length === 0)) reasons.push(`the scored set has ${good.length} known-good and ${bad.length} known-bad case(s); both are needed`);
  let result: EvalReport["result"] = "pass";
  if (reasons.length > 0) {
    result = "insufficient";
  } else {
    if (newFalseApprovals.length > EVAL_THRESHOLDS.maxNewFalseApprovals) reasons.push(`${newFalseApprovals.length} new false approval(s) on known-bad cases (hard fail)`);
    if (newFalseVetoes.length > allowedNewFalseVetoes) reasons.push(`${newFalseVetoes.length} new false veto(es) on known-good cases (allowed ${allowedNewFalseVetoes})`);
    if (reasons.length > 0) result = "fail";
  }

  return {
    split,
    candidate: { patchSha256: opts.candidate.patchSha256, files: opts.candidate.files, touchesSkills: opts.candidate.touchesSkills },
    counts: {
      total: cases.length,
      dev: cases.filter((c) => c.split === "dev").length,
      heldout: cases.filter((c) => c.split === "heldout").length,
      good: cases.filter((c) => c.label === "good").length,
      bad: cases.filter((c) => c.label === "bad").length,
      disputes: cases.filter((c) => c.dispute).length,
      mutants: cases.filter((c) => c.kind === "mutant").length,
      unreplayable: skipped,
      withoutIssueText: cases.filter((c) => c.body === null).length,
    },
    milestones: milestoneProgress(cases.length),
    selected: chosen.length,
    scored: { good: good.length, bad: bad.length },
    errors: base.errors + cand.errors,
    cacheHits: base.cacheHits + cand.cacheHits,
    baseline: { falseApprovals: bA, falseVetoes: bV },
    candidateArm: { falseApprovals: cA, falseVetoes: cV },
    newFalseApprovals,
    newFalseVetoes,
    fixedFalseApprovals: bA.filter((id) => !cA.includes(id)),
    fixedFalseVetoes: bV.filter((id) => !cV.includes(id)),
    allowedNewFalseVetoes,
    result,
    reasons,
  };
}

/** Case counts against the calibration milestones; shown by every eval command. */
export function renderCounts(r: Pick<EvalReport, "counts" | "milestones">): string[] {
  const c = r.counts;
  const next = r.milestones.next;
  return [
    `vault: ${c.total} replayable case(s) (${c.dev} dev, ${c.heldout} held-out; ${c.good} known-good, ${c.bad} known-bad: ${c.disputes} owner dispute(s), ${c.mutants} seeded); ${c.unreplayable} not replayable; ${c.withoutIssueText} without issue text (reviewers get the title only)`,
    `calibration: ${EVAL_THRESHOLDS.minCases} cases minimum to score; thresholds are PROVISIONAL guesses to be recalibrated at ${EVAL_THRESHOLDS.milestones.join(" and ")} cases${next === null ? " (both reached)" : `; ${next - c.total} more to the next milestone (${next})`}`,
  ];
}

export function renderEval(r: EvalReport): string {
  const lines = [
    `=== Eval: candidate ${r.candidate.patchSha256.slice(0, 12)} (${r.candidate.files.join(", ")}) on the ${r.split} set ===`,
    ...renderCounts(r),
    `thresholds (PROVISIONAL, recalibrate at ${EVAL_THRESHOLDS.milestones.join(" and ")} cases): min ${EVAL_THRESHOLDS.minCases} scored cases; 0 new false approvals; at most ${EVAL_THRESHOLDS.maxNewFalseVetoesPer10Good} new false veto per 10 known-good`,
    `selected ${r.selected}, scored ${r.scored.good + r.scored.bad} (${r.scored.good} good, ${r.scored.bad} bad); ${r.errors} reviewer error(s) left out; ${r.cacheHits} cached verdict(s)`,
    `false approvals (known-bad approved): baseline ${r.baseline.falseApprovals.length}, candidate ${r.candidateArm.falseApprovals.length}`,
    `false vetoes (known-good vetoed): baseline ${r.baseline.falseVetoes.length}, candidate ${r.candidateArm.falseVetoes.length}`,
    `new false approvals: ${r.newFalseApprovals.length}; new false vetoes: ${r.newFalseVetoes.length} (allowed ${r.allowedNewFalseVetoes}); fixed false approvals: ${r.fixedFalseApprovals.length}; fixed false vetoes: ${r.fixedFalseVetoes.length}`,
  ];
  for (const id of r.newFalseApprovals) lines.push(`  NEW FALSE APPROVAL: ${id}`);
  for (const id of r.newFalseVetoes) lines.push(`  NEW FALSE VETO: ${id}`);
  if (r.candidate.touchesSkills) lines.push("note: the patch changes skills, which the review stage does not read; only prompts and the rubric are exercised here.");
  lines.push(r.result === "pass" ? "PASS (provisional): no regression against the baseline." : r.result === "insufficient" ? `INSUFFICIENT DATA: ${r.reasons.join("; ")}.` : `FAIL: ${r.reasons.join("; ")}.`);
  lines.push("This report never lands anything: prompt, rubric and skill changes always need the owner's merge.");
  return lines.join("\n");
}
