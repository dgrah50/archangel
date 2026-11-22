import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReviewPromptBuilders, ReviewRequest, ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { prepareCandidates, patchFiles } from "../src/core/eval-candidate.js";
import { EVAL_THRESHOLDS, promptHashFor, renderCounts, renderEval, runEval, splitOf, collectEvalCases, type EvalOptions } from "../src/core/eval.js";
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

/** A watched repo with `good` merged fixes (each with a test), pinned in a bare repo, plus a temp "Archangel" checkout to patch. */
async function world(good: number, opts: { dispute?: number[]; closed?: number[]; noBody?: boolean } = {}): Promise<World> {
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
  for (let n = 1; n <= good + (opts.closed?.length ?? 0); n++) {
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
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  for (const [n, head] of Object.entries(heads).map(([k, v]) => [Number(k), v] as const)) {
    await broker.pinEvalRef("acme/app", n, head);
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
  return { root, bare, ledger, archangel, patch, sources: () => [{ repo: "acme/app", bareRepoPath: bare, seeds: ledger.listReplaySeeds(0, "acme/app") }] };
}

const cleanup = (w: World) => {
  w.ledger.close();
  fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
  it("splits by a hash of the case id, deterministically, roughly 60/40", () => {
    expect(splitOf("acme/app#1:abcdef")).toBe(splitOf("acme/app#1:abcdef"));
    const dev = Array.from({ length: 400 }, (_, i) => splitOf(`case-${i}`)).filter((s) => s === "dev").length;
    expect(dev).toBeGreaterThan(200);
    expect(dev).toBeLessThan(280);
  });

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
  it("passes a candidate that changes nothing that matters, and scores baseline against labels", async () => {
    const w = await world(10);
    try {
      const r = await run(w, "NEUTRAL");
      expect(r.result).toBe("pass");
      expect(r.scored.good + r.scored.bad).toBeGreaterThanOrEqual(EVAL_THRESHOLDS.minCases);
      expect(r.newFalseApprovals).toEqual([]);
      expect(r.newFalseVetoes).toEqual([]);
      expect(r.baseline.falseApprovals).toEqual([]); // the baseline reviewers catch every seeded corruption
      expect(renderEval(r)).toContain("PASS (provisional)");
      expect(renderEval(r)).toContain("PROVISIONAL");
      expect(renderEval(r)).toContain("owner's merge");
    } finally {
      cleanup(w);
    }
  });

  it("hard-fails a candidate that newly approves a known-bad case", async () => {
    const w = await world(10);
    try {
      const r = await run(w, "LENIENT");
      expect(r.result).toBe("fail");
      expect(r.newFalseApprovals.length).toBeGreaterThan(0);
      expect(r.reasons.join(" ")).toContain("hard fail");
      expect(renderEval(r)).toContain("NEW FALSE APPROVAL");
    } finally {
      cleanup(w);
    }
  });

  it("fails a candidate that newly vetoes more known-good cases than allowed, and reports fixes it makes", async () => {
    const w = await world(10);
    try {
      const r = await run(w, "STRICT");
      expect(r.result).toBe("fail");
      expect(r.newFalseVetoes.length).toBeGreaterThan(r.allowedNewFalseVetoes);
      expect(r.newFalseApprovals).toEqual([]);
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
      const capped = await run(await world(10), "NEUTRAL", { maxCases: 3 });
      expect(capped.result).toBe("insufficient");
    } finally {
      cleanup(w);
    }
  });

  it("scores the dev set by default and the held-out set only on request, and caps the cases", async () => {
    const w = await world(10, { dispute: [3, 4] });
    try {
      const dev = await run(w, "NEUTRAL");
      const held = await run(w, "NEUTRAL", { heldout: true });
      expect(dev.split).toBe("dev");
      expect(held.split).toBe("heldout");
      expect(held.counts.disputes).toBe(2);
      const capped = await run(w, "NEUTRAL", { maxCases: 5 });
      expect(capped.selected).toBe(5);
    } finally {
      cleanup(w);
    }
  });

  it("caches verdicts per (prompt hash, case): a re-run makes no reviewer calls", async () => {
    const w = await world(10);
    try {
      const calls = { n: 0, requests: [] as ReviewRequest[] };
      const first = await run(w, "NEUTRAL", {}, calls);
      const firstCalls = calls.n;
      expect(firstCalls).toBeGreaterThan(0);
      expect(first.cacheHits).toBe(0);
      const second = await run(w, "NEUTRAL", {}, calls);
      expect(calls.n).toBe(firstCalls); // every verdict came from the Ledger
      expect(second.cacheHits).toBe(2 * (second.scored.good + second.scored.bad));
      // a different candidate shares the baseline's cached verdicts but pays for its own
      const third = await run(w, "LENIENT", {}, calls);
      expect(calls.n - firstCalls).toBe(third.selected);
    } finally {
      cleanup(w);
    }
  });

  it("gives the reviewers the issue text kept at intake, and the title alone for older Threads (counted)", async () => {
    const w = await world(3);
    const old = await world(3, { noBody: true });
    try {
      const calls = { n: 0, requests: [] as ReviewRequest[] };
      await run(w, "NEUTRAL", { maxCases: 40 }, calls);
      expect(calls.requests.some((q) => /^Issue text \d$/.test(q.body))).toBe(true);
      const r = await run(old, "NEUTRAL", {}, { n: 0, requests: calls.requests = [] });
      expect(r.counts.withoutIssueText).toBe(r.counts.total);
      expect(calls.requests.every((q) => q.body === q.title)).toBe(true);
      expect(renderCounts(r).join("\n")).toContain("without issue text");
    } finally {
      cleanup(w);
      cleanup(old);
    }
  });

  it("states the case counts against the calibration milestones", async () => {
    const w = await world(2);
    try {
      const r = await run(w, "NEUTRAL");
      const text = renderCounts(r).join("\n");
      expect(text).toContain(`recalibrated at ${EVAL_THRESHOLDS.milestones.join(" and ")} cases`);
      expect(text).toContain(`more to the next milestone (${EVAL_THRESHOLDS.milestones[0]})`);
    } finally {
      cleanup(w);
    }
  });
});

describe("candidates", () => {
  it("hashes the prompt templates and the rubric, so a changed wording or rubric misses the cache", async () => {
    const w = await world(1);
    try {
      const { baseline, candidate } = await prepareCandidates(w.archangel, w.patch("X"));
      expect(promptHashFor(baseline.prompts, undefined)).not.toBe(promptHashFor(candidate.prompts, undefined));
      expect(promptHashFor(baseline.prompts, undefined)).not.toBe(promptHashFor(baseline.prompts, "a rubric"));
      expect(promptHashFor(baseline.prompts, "r")).toBe(promptHashFor(baseline.prompts, "r"));
      candidate.cleanup();
    } finally {
      cleanup(w);
    }
  });

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
