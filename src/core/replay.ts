import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_POLICY_PATH, type GatePolicy } from "../config.js";
import { isTestFile, runGate, type GateReport, type GateRunOptions } from "../gate/gate.js";
import type { Ledger } from "../ledger/store.js";
import type { WorkClass } from "./work-class.js";
import { workClassOfBranch } from "./work-class.js";
import { Workflow, toGatePolicy } from "./workflow.js";

const execFileP = promisify(execFile);

/**
 * Offline Gate replay. Mechanical only: every label comes from the Ledger (outcomes, owner actions, recorded
 * Attempt failures) or from deterministic commit corruptions. Nothing here calls GitHub or a model, and
 * everything happens in a throwaway clone of the Broker's bare repo (whose eval refs keep the history alive).
 */

export type CaseLabel = "good" | "bad";
export type CaseKind = "merged_fix" | "rejected_attempt" | "owner_closed";

export interface ReplayCase {
  issueNumber: number;
  workClass: WorkClass;
  kind: CaseKind;
  /** good: merged and not reverted, disputed or red. bad: reverted, disputed, closed or abandoned by the owner. */
  label: CaseLabel;
  headSha: string;
  /** What the Gate said when it ran for real (a merged fix passed; a recorded static rejection rejected); null when nothing was recorded. */
  recorded: "pass" | "reject" | null;
  note: string;
}

/** The Attempt error messages that come from the Gate's static checks (diff bounds, protected and binary files). */
const STATIC_REJECTION_RE =
  /^(protected path modified|binary file modified|diff is empty|changed files \d+ exceeds|non-test changed lines|total changed lines)/;

/** Pure: turns Ledger seeds into labelled cases. Threads or heads that are not finished or not labelled are left out. */
export function deriveCases(seeds: ReturnType<Ledger["listReplaySeeds"]>): ReplayCase[] {
  const cases: ReplayCase[] = [];
  for (const t of seeds) {
    const workClass = workClassOfBranch(t.branchName);
    const outcome = t.phase.kind === "done" ? t.phase.outcome : null;
    const merge = t.merges.filter((m) => (outcome === "merged" ? !m.shadowOnly : true)).at(-1);
    if (merge && (outcome === "merged" || outcome === "owner_merged" || outcome === "reverted")) {
      const bad = outcome === "reverted" || merge.disagreed || merge.mainWatch === "red";
      cases.push({
        issueNumber: t.issueNumber,
        workClass,
        kind: "merged_fix",
        label: bad ? "bad" : "good",
        headSha: merge.headSha,
        recorded: "pass",
        note: bad ? (outcome === "reverted" ? "reverted" : merge.disagreed ? "owner disagreed" : "main went red") : outcome,
      });
    } else if ((outcome === "pr_closed" || outcome === "abandoned") && t.lastHead) {
      // Labelled bad by the owner's action; the Gate verdict was not recorded, so this is context, never drift.
      cases.push({ issueNumber: t.issueNumber, workClass, kind: "owner_closed", label: "bad", headSha: t.lastHead, recorded: null, note: outcome });
    }
    for (const a of t.failedAttempts) {
      if (!STATIC_REJECTION_RE.test(a.errorMessage)) continue;
      cases.push({
        issueNumber: t.issueNumber,
        workClass,
        kind: "rejected_attempt",
        label: "bad",
        headSha: a.headSha,
        recorded: "reject",
        note: a.errorMessage.slice(0, 80),
      });
    }
  }
  return cases;
}

export type CaseStatus = "ok" | "regression" | "skipped";
export interface CaseResult extends ReplayCase {
  status: CaseStatus;
  /** Why: the verdict drift, or why the case could not be replayed. */
  detail: string;
  gate?: "pass" | "reject";
  violations?: string[];
}

export interface MutantResult {
  issueNumber: number;
  mutator: string;
  status: "rejected" | "regression" | "skipped";
  detail: string;
}

export interface ReplayReport {
  repo: string;
  cases: CaseResult[];
  mutants: MutantResult[];
  /** Cases the Gate actually ran on (the rest were skipped: not pinned, no base policy, ...). */
  replayed: number;
  regressions: number;
}

export interface ReplayOptions {
  repo: string;
  bareRepoPath: string;
  seeds: ReturnType<Ledger["listReplaySeeds"]>;
  /** Run the repo's test commands (mutants that need them, and the full Gate on good fixes). Executes repo code here. */
  runTests?: boolean;
  /** The Gate to replay with; defaults to the real one. Tests inject stricter or looser ones. */
  gate?: (o: GateRunOptions) => Promise<GateReport>;
  log?: (s: string) => void;
}

const FIXED_ENV = {
  GIT_AUTHOR_NAME: "replay",
  GIT_AUTHOR_EMAIL: "replay@invalid",
  GIT_COMMITTER_NAME: "replay",
  GIT_COMMITTER_EMAIL: "replay@invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<string> {
  const child = execFileP("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...FIXED_ENV, ...env },
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  if (input !== undefined) child.child.stdin?.end(input);
  return (await child).stdout;
}

interface Tree {
  /** path -> blob sha, for the files this mutator wants changed; null removes the path. */
  set: Map<string, { mode: string; sha: string } | null>;
}

/** Builds a commit with `head`'s tree plus `edits`, parented on `base`, using only plumbing and a private index. */
async function mutantCommit(dir: string, base: string, head: string, edits: Tree): Promise<string> {
  const indexFile = path.join(dir, ".git", `replay-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await git(dir, ["read-tree", head], env);
    for (const [p, v] of edits.set) {
      if (v === null) await git(dir, ["update-index", "--force-remove", "--", p], env);
      else await git(dir, ["update-index", "--add", "--cacheinfo", `${v.mode},${v.sha},${p}`], env);
    }
    const tree = (await git(dir, ["write-tree"], env)).trim();
    return (await git(dir, ["commit-tree", tree, "-p", base, "-m", "replay mutant"], env)).trim();
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

async function blob(dir: string, content: string): Promise<{ mode: string; sha: string }> {
  return { mode: "100644", sha: (await git(dir, ["hash-object", "-w", "--stdin"], {}, content)).trim() };
}

async function show(dir: string, rev: string, p: string): Promise<string | null> {
  try {
    return await git(dir, ["show", `${rev}:${p}`]);
  } catch {
    return null;
  }
}

interface Diff {
  added: string[];
  modified: string[];
  deleted: string[];
}

async function diffFiles(dir: string, base: string, head: string): Promise<Diff> {
  const out = await git(dir, ["diff", "--name-status", "-z", "--no-renames", base, head]);
  const parts = out.split("\0").filter(Boolean);
  const d: Diff = { added: [], modified: [], deleted: [] };
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [st, p] = [parts[i]!, parts[i + 1]!];
    (st === "A" ? d.added : st === "D" ? d.deleted : d.modified).push(p);
  }
  return d;
}

const ASSERT_LINE = /\b(assert\w*|expect|require|t\.(Error|Errorf|Fatal|Fatalf)|toBe\w*|toEqual|toThrow\w*)\b/;

interface Mutator {
  name: string;
  /** Needs the repo's test commands to be run to be detected (the static Gate cannot see it). */
  needsTests: boolean;
  /** Returns the tree edits, or null when this fix gives the mutator nothing to corrupt. */
  build(ctx: { dir: string; base: string; head: string; policy: GatePolicy; diff: Diff }): Promise<Tree | null>;
}

/** Deterministic corruptions of a known-good fix. The Gate must reject every one. */
export const MUTATORS: Mutator[] = [
  {
    name: "revert-fix-keep-test",
    needsTests: true,
    async build({ dir, base, policy, diff }) {
      const fix = [...diff.added, ...diff.modified, ...diff.deleted].filter((f) => !isTestFile(f, policy));
      if (fix.length === 0) return null;
      const set: Tree["set"] = new Map();
      for (const f of fix) {
        const old = await show(dir, base, f);
        set.set(f, old === null ? null : await blob(dir, old));
      }
      return { set };
    },
  },
  {
    name: "weaken-test-assertion",
    needsTests: true,
    async build({ dir, head, policy, diff }) {
      const set: Tree["set"] = new Map();
      for (const f of diff.added.filter((x) => isTestFile(x, policy))) {
        const text = await show(dir, head, f);
        if (text === null) continue;
        const kept = text.split("\n").filter((l) => !ASSERT_LINE.test(l)).join("\n");
        if (kept !== text) set.set(f, await blob(dir, kept));
      }
      return set.size > 0 ? { set } : null;
    },
  },
  {
    name: "touch-protected-path",
    needsTests: false,
    async build({ dir }) {
      return { set: new Map([[".github/workflows/replay-mutant.yml", await blob(dir, "name: mutant\n")]]) };
    },
  },
  {
    name: "drop-new-tests",
    needsTests: false,
    async build({ policy, diff }) {
      const tests = diff.added.filter((f) => isTestFile(f, policy));
      return tests.length > 0 ? { set: new Map(tests.map((f) => [f, null] as const)) } : null;
    },
  },
  {
    name: "edit-existing-test",
    needsTests: false,
    async build({ dir, base, head, policy, diff }) {
      const files = (await git(dir, ["ls-tree", "-r", "--name-only", base])).split("\n").filter(Boolean).sort();
      const existing = files.find((f) => isTestFile(f, policy) && !diff.deleted.includes(f));
      if (!existing) return null;
      const text = (await show(dir, head, existing)) ?? (await show(dir, base, existing)) ?? "";
      return { set: new Map([[existing, await blob(dir, `${text}\n// replay mutant\n`)]]) };
    },
  },
  {
    name: "exceed-diff-budget",
    needsTests: false,
    async build({ dir, policy }) {
      const bulk = Array.from({ length: policy.maxNonTestLines + 1 }, (_, i) => `line ${i}`).join("\n") + "\n";
      return { set: new Map([["replay-mutant-bulk.txt", await blob(dir, bulk)]]) };
    },
  },
];

async function pinnedShas(dir: string, repo: string, issue: number): Promise<Set<string>> {
  const out = await git(dir, ["for-each-ref", "--format=%(objectname)", `refs/archangel/eval/${repo}/${issue}/`]);
  return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
}

/** The base's policy, or why there is none usable (an old-format or missing file cannot be replayed). */
async function basePolicy(dir: string, base: string): Promise<{ policy: GatePolicy } | { reason: string }> {
  const raw = await show(dir, base, REPO_POLICY_PATH);
  if (raw === null) return { reason: `no ${REPO_POLICY_PATH} at the base commit` };
  try {
    const parsed = Workflow.safeParse(JSON.parse(raw));
    return parsed.success ? { policy: toGatePolicy(parsed.data.gate) } : { reason: "workflow file at the base is not a valid workflow (pre-V4?)" };
  } catch {
    return { reason: "workflow file at the base is not valid JSON" };
  }
}

export async function runReplay(opts: ReplayOptions): Promise<ReplayReport> {
  const gate = opts.gate ?? runGate;
  const log = opts.log ?? (() => undefined);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-replay-"));
  const dir = path.join(tmp, "clone");
  const report: ReplayReport = { repo: opts.repo, cases: [], mutants: [], replayed: 0, regressions: 0 };
  try {
    // A throwaway local clone: the bare repo is never modified, and nothing leaves this machine.
    await git(tmp, ["clone", "--no-local", "--quiet", opts.bareRepoPath, dir]);
    // A failure here must surface: swallowing it would make every case look unpinned and the run pass vacuously.
    await git(dir, ["fetch", "--quiet", opts.bareRepoPath, "+refs/archangel/eval/*:refs/archangel/eval/*"]);
    const mainRef = (await git(dir, ["rev-parse", "--verify", "refs/remotes/origin/HEAD"]).catch(() => "")).trim() || "HEAD";

    for (const c of deriveCases(opts.seeds)) {
      const skip = (detail: string): void => {
        report.cases.push({ ...c, status: "skipped", detail });
      };
      if (!(await pinnedShas(dir, opts.repo, c.issueNumber)).has(c.headSha)) {
        skip("head is not pinned in the eval refs (captured before capture existed, or pruned)");
        continue;
      }
      let base: string;
      try {
        base = (await git(dir, ["merge-base", c.headSha, mainRef])).trim();
      } catch {
        skip("no merge base with main");
        continue;
      }
      if (base === c.headSha) {
        skip("head is already on main (no diff to replay)");
        continue;
      }
      const pol = await basePolicy(dir, base);
      if ("reason" in pol) {
        skip(pol.reason);
        continue;
      }
      const run = (head: string, tests: boolean) =>
        gate({ repoDir: dir, baseRef: base, headRef: head, workClass: c.workClass, skipPreCommit: true, skipTests: !tests });
      let verdict: GateReport;
      try {
        verdict = await run(c.headSha, Boolean(opts.runTests));
      } catch (err) {
        skip(`Gate errored: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const now: "pass" | "reject" = verdict.passed ? "pass" : "reject";
      const drift = c.recorded !== null && now !== c.recorded;
      const detail = drift
        ? c.recorded === "pass"
          ? `Gate would now REJECT a merged fix: ${verdict.violations[0] ?? "no violation text"}`
          : "Gate would now ACCEPT a diff it rejected when it ran"
        : `Gate ${now} (recorded ${c.recorded})`;
      report.cases.push({ ...c, status: drift ? "regression" : "ok", detail, gate: now, violations: verdict.violations });

      // Mutants: corrupt each replayable merged good fix; the current Gate must reject every one.
      if (c.label === "good" && c.kind === "merged_fix" && c.workClass === "bugfix") {
        const diff = await diffFiles(dir, base, c.headSha);
        for (const m of MUTATORS) {
          if (m.needsTests && !opts.runTests) {
            report.mutants.push({ issueNumber: c.issueNumber, mutator: m.name, status: "skipped", detail: "needs --run-tests (runs the repo's tests on this machine)" });
            continue;
          }
          const edits = await m.build({ dir, base, head: c.headSha, policy: pol.policy, diff });
          if (!edits) {
            report.mutants.push({ issueNumber: c.issueNumber, mutator: m.name, status: "skipped", detail: "nothing to corrupt in this fix" });
            continue;
          }
          const mutant = await mutantCommit(dir, base, c.headSha, edits);
          let r: GateReport;
          try {
            r = await run(mutant, m.needsTests);
          } catch (err) {
            report.mutants.push({ issueNumber: c.issueNumber, mutator: m.name, status: "rejected", detail: `Gate threw: ${err instanceof Error ? err.message : String(err)}` });
            continue;
          }
          report.mutants.push(
            r.passed
              ? { issueNumber: c.issueNumber, mutator: m.name, status: "regression", detail: "Gate ACCEPTED the corrupted fix" }
              : { issueNumber: c.issueNumber, mutator: m.name, status: "rejected", detail: r.violations[0] ?? "rejected" },
          );
          log(`mutant ${m.name} #${c.issueNumber}: ${r.passed ? "ACCEPTED" : "rejected"}`);
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  report.replayed = report.cases.filter((c) => c.status !== "skipped").length;
  report.regressions = report.cases.filter((c) => c.status === "regression").length + report.mutants.filter((m) => m.status === "regression").length;
  return report;
}

export function renderReplay(r: ReplayReport): string {
  const lines = [`=== Replay: ${r.repo} ===`];
  const count = (xs: Array<{ status: string }>, s: string) => xs.filter((x) => x.status === s).length;
  lines.push(`cases: ${r.cases.length} (${count(r.cases, "ok")} ok, ${count(r.cases, "regression")} regression, ${count(r.cases, "skipped")} skipped)`);
  for (const c of r.cases) lines.push(`  #${c.issueNumber} ${c.kind} [${c.label}] ${c.status.toUpperCase()}: ${c.detail}`);
  lines.push(`mutants: ${r.mutants.length} (${count(r.mutants, "rejected")} rejected, ${count(r.mutants, "regression")} ACCEPTED, ${count(r.mutants, "skipped")} skipped)`);
  for (const m of r.mutants.filter((x) => x.status !== "rejected")) lines.push(`  #${m.issueNumber} ${m.mutator} ${m.status.toUpperCase()}: ${m.detail}`);
  lines.push(`replayed ${r.replayed} of ${r.cases.length} cases`);
  if (r.replayed === 0) lines.push("NOTHING WAS REPLAYED: this run proves nothing about the Gate.");
  lines.push(r.regressions === 0 ? "No regressions." : `${r.regressions} REGRESSION(S).`);
  return lines.join("\n");
}
