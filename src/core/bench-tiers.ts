import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Implementer } from "../agents/implementer.js";
import { buildImplementPrompt, promptTemplateSha } from "../agents/prompts.js";
import { GitBroker } from "../broker/git-broker.js";
import { ProviderEntrySchema, WRITER_ROLES, type ProviderEntry, type WriterRole } from "../config.js";
import type { Ledger } from "../ledger/store.js";
import { basePolicy, deriveCases, git, openReplayClone, pinnedShas } from "./replay.js";

/**
 * Model-tier benchmark (L4): replays captured implementation cases with a candidate provider chain and with the current one, and
 * scores each produced diff mechanically with the Gate (static checks, plus red-on-base / green-on-head with `runTests`), the diff
 * size, the provider attempts and the wall time. No model grades another model. It spends real subscription calls, so it is capped
 * and every (chain, case) result is cached. It never edits archangel.yaml: it prints the snippet the owner would paste.
 */
export const BENCH = {
  /** Each case runs a real implementer twice (current and candidate): cap them unless `--max-cases` says otherwise. */
  defaultMaxCases: 6,
  /** Fewer cases than this scored on both chains is "insufficient data", never a verdict. */
  minCases: 5,
} as const;

export interface BenchCase {
  id: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  workClass: "bugfix" | "feature";
  baseSha: string;
  bareRepoPath: string;
}

export interface ArmResult {
  /** The Gate (and static bounds) accepted the produced diff. */
  passed: boolean;
  violations: string[];
  diffLines: number;
  /** Providers that ran before the work finished (failovers count). */
  attempts: number;
  wallMs: number;
}

export interface BenchSource {
  repo: string;
  bareRepoPath: string;
  seeds: ReturnType<Ledger["listReplaySeeds"]>;
}

/** `codex:gpt-5,agy` -> provider entries; an unknown provider or empty entry is an error. */
export function parseChain(spec: string): ProviderEntry[] {
  const entries = spec.split(",").map((s) => s.trim());
  if (entries.length === 0 || entries.some((e) => e === "")) throw new Error("--candidate-chain needs provider[:model] entries separated by commas");
  return entries.map((e) => {
    const i = e.indexOf(":");
    return ProviderEntrySchema.parse(i === -1 ? { provider: e } : { provider: e.slice(0, i), model: e.slice(i + 1) });
  });
}

export const chainLabel = (chain: ProviderEntry[]): string => chain.map((e) => (e.model ? `${e.provider}:${e.model}` : e.provider)).join(",");

/** Known-good merged fixes whose issue text was kept at intake and whose head is still pinned: the replayable implementation cases. */
export async function collectBenchCases(sources: BenchSource[]): Promise<{ cases: BenchCase[]; skipped: number }> {
  const cases: BenchCase[] = [];
  let skipped = 0;
  for (const src of sources) {
    const clone = await openReplayClone(src.bareRepoPath);
    try {
      for (const c of deriveCases(src.seeds)) {
        if (c.kind !== "merged_fix" || c.label !== "good") continue;
        const seed = src.seeds.find((s) => s.issueNumber === c.issueNumber)!;
        if (seed.issueBody === null || !(await pinnedShas(clone.dir, src.repo, c.issueNumber)).has(c.headSha)) {
          skipped++;
          continue;
        }
        let base: string;
        try {
          base = (await git(clone.dir, ["merge-base", c.headSha, clone.mainRef])).trim();
        } catch {
          skipped++;
          continue;
        }
        if (base === c.headSha) {
          skipped++;
          continue;
        }
        cases.push({
          id: `${src.repo}#${c.issueNumber}:${base.slice(0, 12)}`,
          repo: src.repo,
          issueNumber: c.issueNumber,
          title: seed.title,
          body: seed.issueBody,
          workClass: c.workClass,
          baseSha: base,
          bareRepoPath: src.bareRepoPath,
        });
      }
    } finally {
      clone.cleanup();
    }
  }
  return { cases, skipped };
}

/** Deterministic pick of up to `max` cases, so repeated runs hit the cache. */
function pick(cases: BenchCase[], max: number): BenchCase[] {
  const key = (c: BenchCase) => crypto.createHash("sha256").update(c.id).digest("hex");
  return [...cases].sort((a, b) => key(a).localeCompare(key(b))).slice(0, max);
}

/** Everything that decides a result: the role, the chain, whether tests ran, and the implement prompt wording. */
export function cacheKey(role: WriterRole, chain: ProviderEntry[], runTests: boolean): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ role, chain, runTests, prompt: promptTemplateSha("implement") }))
    .digest("hex");
}

export interface BenchOptions {
  ledger: Ledger;
  sources: BenchSource[];
  role: WriterRole;
  currentChain: ProviderEntry[];
  candidateChain: ProviderEntry[];
  /** Builds the implementer that runs `chain` for the role (real CLIs in production, fakes in tests). */
  implementerFor: (chain: ProviderEntry[], role: WriterRole) => Implementer;
  runTests?: boolean;
  maxCases?: number;
  implementMaxTurns?: number;
  implementTimeoutMs?: number;
  setupTimeoutMs?: number;
  now?: number;
}

export interface ArmSummary {
  chain: string;
  scored: number;
  errors: number;
  passRate: number | null;
  meanDiffLines: number | null;
  meanWallSec: number | null;
  meanAttempts: number | null;
}

export interface BenchReport {
  role: WriterRole;
  runTests: boolean;
  casesAvailable: number;
  unreplayable: number;
  selected: number;
  cacheHits: number;
  current: ArmSummary;
  candidate: ArmSummary;
  /** Cases both chains produced a result for. */
  comparable: number;
  matchedOrBeat: number;
  perCase: Array<{ id: string; current: ArmResult | null; candidate: ArmResult | null }>;
  verdict: "insufficient" | "matched_or_beat" | "worse";
  verdictLine: string;
  /** What the owner would paste into archangel.yaml; null unless the candidate matched or beat the current chain. */
  snippet: string | null;
}

async function runArm(c: BenchCase, chain: ProviderEntry[], opts: BenchOptions, broker: GitBroker, role: WriterRole): Promise<ArmResult> {
  const started = Date.now();
  const policy = await basePolicy(c.bareRepoPath, c.baseSha);
  if ("reason" in policy) throw new Error(`cannot replay ${c.id}: ${policy.reason}`);
  const clone = await broker.createThrowawayClone(c.issueNumber, c.baseSha);
  try {
    await broker.runRepoSetup(clone, c.baseSha, opts.setupTimeoutMs);
    const result = await opts.implementerFor(chain, role).run({
      issueNumber: c.issueNumber,
      cloneDir: clone,
      prompt: buildImplementPrompt({ issueNumber: c.issueNumber, title: c.title, body: c.body, repoName: c.repo, gate: policy.policy, workClass: c.workClass }),
      abortController: new AbortController(),
      maxTurns: opts.implementMaxTurns ?? 60,
      timeoutMs: opts.implementTimeoutMs ?? 20 * 60_000,
      maxBudgetUsd: 0,
      role,
    });
    if (result.aborted || result.failure) throw new Error(result.failure ? `implementer ended with ${result.failure}` : "implementer aborted");
    const v = await broker.fetchAndValidateFromClone(clone, c.issueNumber, c.baseSha, policy.policy, c.workClass);
    const violations = [...v.protectedViolations, ...(v.gateReport ? v.gateReport.violations : [])];
    return {
      passed: v.protectedViolations.length === 0 && v.gateReport !== undefined && v.gateReport.passed,
      violations: violations.slice(0, 5).map((s) => s.slice(0, 200)),
      diffLines: v.totalLines,
      attempts: Math.max(1, result.providersUsed?.length ?? 1),
      wallMs: Date.now() - started,
    };
  } finally {
    broker.removeClone(clone);
  }
}

function summarize(chain: ProviderEntry[], results: Array<ArmResult | null>): ArmSummary {
  const ok = results.filter((r): r is ArmResult => r !== null);
  const mean = (f: (r: ArmResult) => number) => (ok.length === 0 ? null : Number((ok.reduce((s, r) => s + f(r), 0) / ok.length).toFixed(2)));
  return {
    chain: chainLabel(chain),
    scored: ok.length,
    errors: results.length - ok.length,
    passRate: ok.length === 0 ? null : Number((ok.filter((r) => r.passed).length / ok.length).toFixed(2)),
    meanDiffLines: mean((r) => r.diffLines),
    meanWallSec: mean((r) => r.wallMs / 1000),
    meanAttempts: mean((r) => r.attempts),
  };
}

export function chainSnippet(role: WriterRole, chain: ProviderEntry[]): string {
  return [
    "chains:",
    `  ${role}:`,
    ...chain.flatMap((e) => [`    - provider: ${e.provider}`, ...(e.model ? [`      model: ${e.model}`] : [])]),
  ].join("\n");
}

export async function runBenchTiers(opts: BenchOptions): Promise<BenchReport> {
  if (!(WRITER_ROLES as readonly string[]).includes(opts.role)) throw new Error(`unknown role ${opts.role}`);
  const runTests = opts.runTests ?? false;
  const { cases, skipped } = await collectBenchCases(opts.sources);
  const chosen = pick(cases, opts.maxCases ?? BENCH.defaultMaxCases);

  // Revise and rebase need the review feedback or the conflict, which are not captured: only `implement` has replayable inputs.
  const replayable = opts.role === "implement" ? chosen : [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-bench-"));
  let cacheHits = 0;
  const current: Array<ArmResult | null> = [];
  const candidate: Array<ArmResult | null> = [];
  try {
    const brokers = new Map<string, GitBroker>();
    const brokerFor = async (c: BenchCase) => {
      let b = brokers.get(c.bareRepoPath);
      if (!b) {
        // A private copy of the Broker's bare repo: neither the live repo nor its refs are touched.
        const bare = path.join(tmp, `${brokers.size}.git`);
        await git(tmp, ["clone", "--bare", "--no-local", "--quiet", c.bareRepoPath, bare]);
        b = new GitBroker({ bareRepoPath: bare, clonesDir: path.join(tmp, `clones-${brokers.size}`), enableLocalGate: true, localGateSkipTests: !runTests });
        brokers.set(c.bareRepoPath, b);
      }
      return b;
    };
    const arm = async (c: BenchCase, chain: ProviderEntry[]): Promise<ArmResult | null> => {
      const key = cacheKey(opts.role, chain, runTests);
      const cached = opts.ledger.getBenchResult(key, c.id);
      if (cached) {
        cacheHits++;
        return cached as ArmResult;
      }
      try {
        const r = await runArm(c, chain, opts, await brokerFor(c), opts.role);
        opts.ledger.putBenchResult(key, c.id, r, opts.now);
        return r;
      } catch {
        return null; // a failed run is an error for this case, not a failing score; it is never cached
      }
    };
    for (const c of replayable) {
      current.push(await arm(c, opts.currentChain));
      candidate.push(await arm(c, opts.candidateChain));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  const both = replayable.map((_, i) => i).filter((i) => current[i] && candidate[i]);
  const matchedOrBeat = both.filter((i) => Number(candidate[i]!.passed) >= Number(current[i]!.passed)).length;
  const cur = summarize(opts.currentChain, current);
  const cand = summarize(opts.candidateChain, candidate);
  let verdict: BenchReport["verdict"];
  let verdictLine: string;
  if (opts.role !== "implement") {
    verdict = "insufficient";
    verdictLine = `insufficient data: no replayable ${opts.role} cases (the review feedback and conflicts they start from are not captured); only implement can be benchmarked`;
  } else if (both.length < BENCH.minCases) {
    verdict = "insufficient";
    verdictLine = `insufficient data: ${both.length} case(s) scored on both chains; at least ${BENCH.minCases} are required (${cases.length} replayable, ${skipped} not)`;
  } else if ((cand.passRate ?? 0) >= (cur.passRate ?? 0)) {
    verdict = "matched_or_beat";
    verdictLine = `candidate matched or beat current on ${matchedOrBeat}/${both.length} cases (pass rate ${cand.passRate} vs ${cur.passRate})`;
  } else {
    verdict = "worse";
    verdictLine = `candidate matched or beat current on only ${matchedOrBeat}/${both.length} cases (pass rate ${cand.passRate} vs ${cur.passRate}); not recommended`;
  }
  return {
    role: opts.role,
    runTests,
    casesAvailable: cases.length,
    unreplayable: skipped,
    selected: replayable.length,
    cacheHits,
    current: cur,
    candidate: cand,
    comparable: both.length,
    matchedOrBeat,
    perCase: replayable.map((c, i) => ({ id: c.id, current: current[i] ?? null, candidate: candidate[i] ?? null })),
    verdict,
    verdictLine,
    snippet: verdict === "matched_or_beat" ? chainSnippet(opts.role, opts.candidateChain) : null,
  };
}

export function renderBench(r: BenchReport): string {
  const fmt = (v: number | null, unit = "") => (v === null ? "n/a" : `${v}${unit}`);
  const arm = (label: string, a: ArmSummary) =>
    `${label} ${a.chain}: scored ${a.scored}, errors ${a.errors}, pass rate ${fmt(a.passRate)}, mean diff ${fmt(a.meanDiffLines, " lines")}, mean time ${fmt(a.meanWallSec, "s")}, mean provider attempts ${fmt(a.meanAttempts)}`;
  const lines = [
    `=== Model-tier benchmark: ${r.role} chain (${r.runTests ? "Gate with tests: red on base, green on head" : "static Gate only"}) ===`,
    `${r.casesAvailable} replayable case(s), ${r.unreplayable} not replayable; ran ${r.selected}; ${r.cacheHits} cached result(s). Real subscription calls were made for every uncached run.`,
    arm("current  ", r.current),
    arm("candidate", r.candidate),
    `verdict: ${r.verdictLine}`,
  ];
  if (r.snippet) lines.push("", "To adopt it, paste this into archangel.yaml yourself (this command never edits it):", r.snippet);
  return lines.join("\n");
}
