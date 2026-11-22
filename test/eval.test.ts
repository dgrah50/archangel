import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";

import type { ReviewPromptBuilders, ReviewRequest, ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { prepareCandidates, patchFiles } from "../src/core/eval-candidate.js";
import { EVAL_THRESHOLDS, renderEval, runEval, collectEvalCases, type EvalOptions } from "../src/core/eval.js";
import { Ledger } from "../src/ledger/store.js";

const FIXED = { GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
const git = (cwd: string, args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...FIXED } }).trim();
const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const POLICY = {
  version: 1,
  gate: { testFileGlobs: ["tests/*.test.mjs"], testCmd: "true" },
  requiredChecks: ["Gate", "Test"],
};

interface World {
  root: string;
  bare: string;
  ledger: Ledger;
  archangel: string;
  patch: (marker: string) => string;
  sources: () => EvalOptions["sources"];
}

/** The git half of a world (watched repo, pinned bare repo, "Archangel" checkout) is built once per distinct shape and shared; each test gets its own Ledger. */
interface Fixture { root: string; bare: string; archangel: string; heads: Record<number, string>; patch: World["patch"] }
const fixtures = new Map<string, Promise<Fixture>>();
afterAll(async () => {
  for (const f of fixtures.values()) fs.rmSync((await f).root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function buildFixture(good: number, closed: number): Promise<Fixture> {
  const key = `${good}/${closed}`;
  let f = fixtures.get(key);
  if (!f) fixtures.set(key, (f = buildFixtureUncached(good, closed)));
  return f;
}

async function buildFixtureUncached(good: number, closedCount: number): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-eval-test-"));
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(work, ["init", "-q", "-b", "main"]);
  write(work, "calc.mjs", "export function add(a, b) {\n  return a - b;\n}\n");
  write(work, "tests/existing.test.mjs", 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n');
  write(work, ".agents/archangel.json", JSON.stringify(POLICY));
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "base"]);
  const heads: Record<number, string> = {};
  for (let n = 1; n <= good + closedCount; n++) {
    git(work, ["checkout", "-q", "-b", `factory/${n}`, "main"]);
    write(work, "calc.mjs", `export function add(a, b) {\n  return a + b + ${n - n}; // fix ${n}\n}\n`);
    write(work, `tests/issue${n}.test.mjs`, `import assert from "node:assert/strict";\nassert.equal(${n}, ${n});\n`);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-qm", `fix ${n}`]);
    heads[n] = git(work, ["rev-parse", "HEAD"]);
    git(work, ["checkout", "-q", "main"]);
  }
  const bare = path.join(root, "broker.git");
  git(root, ["clone", "-q", "--bare", work, bare]);
  const broker = new GitBroker({ bareRepoPath: bare, clonesDir: path.join(root, "clones") });
  for (const n of Object.keys(heads).map(Number)) await broker.pinEvalRef("acme/app", n, heads[n]!);
  // a temp "Archangel" checkout holding the real prompts and policy, to patch
  const archangel = path.join(root, "archangel");
  fs.mkdirSync(archangel);
  git(archangel, ["init", "-q", "-b", "main"]);
  write(archangel, "src/agents/prompts.ts", fs.readFileSync("src/agents/prompts.ts", "utf8"));
  write(archangel, ".agents/archangel.json", fs.readFileSync(".agents/archangel.json", "utf8"));
  git(archangel, ["add", "-A"]);
  git(archangel, ["commit", "-qm", "archangel"]);
  const patch = (marker: string) => {
    const file = path.join(root, `${marker}.patch`);
    if (fs.existsSync(file)) return file;
    const scratch = path.join(root, `scratch-${marker}`);
    git(root, ["clone", "-q", archangel, scratch]);
    const f = path.join(scratch, "src/agents/prompts.ts");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"Check strictly:",', `"Check strictly: ${marker}",`));
    fs.writeFileSync(file, git(scratch, ["diff"]) + "\n");
    return file;
  };
  return { root, bare, archangel, heads, patch };
}

/** A watched repo with `good` merged fixes (each with a test), pinned in a bare repo, plus a temp "Archangel" checkout to patch. */
async function world(good: number, opts: { dispute?: number[]; closed?: number[]; noBody?: boolean } = {}): Promise<World> {
  const { root, bare, archangel, heads, patch } = await buildFixture(good, opts.closed?.length ?? 0);
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  for (const [n, head] of Object.entries(heads).map(([k, v]) => [Number(k), v] as const)) {
    const isClosed = opts.closed?.includes(n);
    ledger.upsertThread({
      issueNumber: n, title: `Bug ${n}`, bodySha256: "b", branchName: `factory/${n}`, now: 1,
      issueBody: opts.noBody ? null : `Issue text ${n}`,
      phase: (isClosed ? { kind: "done", outcome: "pr_closed" } : { kind: "done", outcome: "merged" }) as never,
    });
    const a = ledger.startAttempt(n, "implement", 1);
    ledger.finishAttempt(a.id, { status: "succeeded", headSha: head }, 2);
    if (!isClosed) {
      ledger.recordMerge({ issueNumber: n, prNumber: n, headSha: head, squashSha: "s", shadowOnly: false, mainRequired: ["Test"], now: 1 });
      if (opts.dispute?.includes(n)) ledger.markDisagree(n, true);
    }
  }
  return { root, bare, ledger, archangel, patch, sources: () => [{ repo: "acme/app", bareRepoPath: bare, seeds: ledger.listReplaySeeds(0, "acme/app") }] };
}

const cleanup = (w: World) => {
  w.ledger.close();
};

/** Fake reviewers: the prompt wording decides leniency (LENIENT approves everything, STRICT vetoes everything); otherwise a
 * diff that lacks the fix, the new test, an assertion, or carries a corruption marker is vetoed. No model is ever called. */
function fakeSuite(prompts: ReviewPromptBuilders, calls: { n: number; requests: ReviewRequest[] } = { n: 0, requests: [] }): ReviewerSuite {
  return {
    async reviewAll(req) {
      calls.n++;
      calls.requests.push(req);
      const text = prompts.contract(req);
      const bad = !req.diffText.includes("calc.mjs") || !/tests\/issue\d+\.test\.mjs/.test(req.diffText) || !req.diffText.includes("assert") || req.diffText.includes("replay mutant");
      const verdict = text.includes("STRICT") ? "veto" : text.includes("LENIENT") ? "approve" : bad ? "veto" : "approve";
      return {
        results: (["openai", "gemini"] as const).map((vendor) => ({ vendor, verdict, findings: [], costUsd: 0 })),
        errors: [],
      };
    },
  };
}

async function run(w: World, marker: string, extra: Partial<EvalOptions> = {}, calls?: { n: number; requests: ReviewRequest[] }) {
  const { baseline, candidate } = await prepareCandidates(w.archangel, w.patch(marker));
  try {
    return await runEval({
      ledger: w.ledger, sources: w.sources(), suiteFor: (p) => fakeSuite(p, calls),
      baseline: baseline.prompts, candidate, maxCases: 40, ...extra,
    });
  } finally {
    candidate.cleanup();
  }
}

describe("vault split and dispute pinning", () => {
  it("pins every owner dispute (disagreed, owner-closed) to held-out for good, and never moves a case back to dev", async () => {
    const w = await world(4, { dispute: [2], closed: [5] });
    try {
      const { cases } = await collectEvalCases(w.ledger, w.sources());
      const real = (n: number) => cases.find((c) => c.issueNumber === n && c.kind !== "mutant")!;
      expect(real(1)).toMatchObject({ label: "good", dispute: false });
      expect(real(2)).toMatchObject({ label: "bad", dispute: true, split: "heldout", kind: "merged_fix" });
      expect(real(5)).toMatchObject({ label: "bad", dispute: true, split: "heldout", kind: "owner_closed" });
      // mutants of good fixes are known-bad but not disputes; the disputed fix gets none
      expect(cases.filter((c) => c.kind === "mutant").every((c) => c.label === "bad" && !c.dispute)).toBe(true);
      expect(cases.some((c) => c.kind === "mutant" && c.issueNumber === 2)).toBe(false);
      // the vault remembers: a held-out case stays held-out whatever the hash says
      const id = real(1).id;
      const before = real(1).split;
      expect(w.ledger.upsertEvalCase({ caseId: id, repo: "acme/app", issueNumber: 1, kind: "merged_fix", label: "good", dispute: false, headSha: "x" }, () => "dev")).toBe(before);
      w.ledger.upsertEvalCase({ caseId: id, repo: "acme/app", issueNumber: 1, kind: "merged_fix", label: "bad", dispute: true, headSha: "x" }, () => "dev");
      expect(w.ledger.upsertEvalCase({ caseId: id, repo: "acme/app", issueNumber: 1, kind: "merged_fix", label: "good", dispute: false, headSha: "x" }, () => "dev")).toBe("heldout");
    } finally {
      cleanup(w);
    }
  });
});

describe("eval scoring", () => {
  it("passes a neutral candidate, and hard-fails one that newly approves a known-bad case", async () => {
    const w = await world(4);
    try {
      const [r, lenient] = await Promise.all([run(w, "NEUTRAL"), run(w, "LENIENT")]);
      expect(r.result).toBe("pass");
      expect(r.scored.good + r.scored.bad).toBeGreaterThanOrEqual(EVAL_THRESHOLDS.minCases);
      expect(r.newFalseApprovals).toEqual([]);
      expect(r.newFalseVetoes).toEqual([]);
      expect(r.baseline.falseApprovals).toEqual([]); // the baseline reviewers catch every seeded corruption
      expect(lenient.result).toBe("fail");
      expect(lenient.newFalseApprovals.length).toBeGreaterThan(0);
    } finally {
      cleanup(w);
    }
  });

  it("prints INSUFFICIENT DATA when fewer than the minimum cases can be scored (never a silent pass)", async () => {
    const w = await world(1);
    try {
      const r = await run(w, "NEUTRAL");
      expect(r.result).toBe("insufficient");
      expect(renderEval(r)).toContain("INSUFFICIENT DATA");
      const w10 = await world(4);
      const capped = await run(w10, "NEUTRAL", { maxCases: 3 });
      cleanup(w10);
      expect(capped.result).toBe("insufficient");
    } finally {
      cleanup(w);
    }
  });

});

describe("candidates", () => {
  it("refuses a patch that touches code outside prompts, skills and the policy file, and one that does not apply", async () => {
    const w = await world(1);
    try {
      const evil = path.join(w.root, "evil.patch");
      fs.writeFileSync(evil, "diff --git a/src/core/reconciler.ts b/src/core/reconciler.ts\n--- a/src/core/reconciler.ts\n+++ b/src/core/reconciler.ts\n@@ -1 +1 @@\n-a\n+b\n");
      await expect(prepareCandidates(w.archangel, evil)).rejects.toThrow(/may only change.*src\/core\/reconciler\.ts/);
      const stale = path.join(w.root, "stale.patch");
      fs.writeFileSync(stale, "diff --git a/src/agents/prompts.ts b/src/agents/prompts.ts\n--- a/src/agents/prompts.ts\n+++ b/src/agents/prompts.ts\n@@ -1 +1 @@\n-nothing like this line\n+x\n");
      await expect(prepareCandidates(w.archangel, stale)).rejects.toThrow();
      expect(patchFiles(fs.readFileSync(w.patch("Y"), "utf8"))).toEqual(["src/agents/prompts.ts"]);
    } finally {
      cleanup(w);
    }
  });
});
