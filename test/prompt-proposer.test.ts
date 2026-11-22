import { describe, expect, it } from "bun:test";
import { Ledger } from "../src/ledger/store.js";
import { proposePrompt, type ProposeDeps } from "../src/core/prompt-proposer.js";
import type { EvalReport } from "../src/core/eval.js";

const diffOf = (added: string[]) =>
  ["diff --git a/src/agents/prompts.ts b/src/agents/prompts.ts", "--- a/src/agents/prompts.ts", "+++ b/src/agents/prompts.ts", "@@ -1 +1,2 @@", " x", ...added.map((l) => `+${l}`), ""].join("\n");
const proposal = (added: string[]) => ({ target: "prompt", file: "src/agents/prompts.ts", diff: diffOf(added), rationale: "prompt_proposer: targets revert-fix-keep-test false approvals" });
const report = (over: Partial<EvalReport>): EvalReport => ({
  split: "heldout", candidate: { patchSha256: "a".repeat(64), files: ["src/agents/prompts.ts"], touchesSkills: false },
  counts: { total: 20, dev: 12, heldout: 8, good: 10, bad: 10, disputes: 1, mutants: 9, unreplayable: 0, withoutIssueText: 0 },
  milestones: { current: 20, next: 40 }, selected: 8, scored: { good: 4, bad: 4 }, errors: 0, cacheHits: 0,
  baseline: { falseApprovals: [], falseVetoes: [] }, candidateArm: { falseApprovals: [], falseVetoes: [] },
  newFalseApprovals: [], newFalseVetoes: [], fixedFalseApprovals: [], fixedFalseVetoes: [], allowedNewFalseVetoes: 0, result: "pass", reasons: [], ...over,
});

function setup(raw: unknown, evalReport: EvalReport) {
  const calls = { eval: 0, pr: [] as string[] };
  const deps: ProposeDeps = {
    ledger: new Ledger(":memory:", { repo: "acme/app" }),
    chain: [{ provider: "claude" }],
    invoker: async () => raw,
    cwd: "/nonexistent",
    failures: async () => ({ scored: 10, falseApprovals: { "revert-fix-keep-test": 2 }, falseVetoes: 0 }),
    clusterBlock: "",
    evaluate: async () => { calls.eval++; return evalReport; },
    openPr: async (draft) => { calls.pr.push(draft.file); return "https://github.com/dgrah50/archangel/pull/1"; },
  };
  return { deps, calls };
}

describe("prompt proposer", () => {
  it("opens a PR only when the held-out eval passes AND fixes a baseline failure, and only once a week", async () => {
    const tie = setup(proposal(["new rule"]), report({}));
    expect((await proposePrompt(tie.deps)).kind).toBe("not_better");
    const worse = setup(proposal(["new rule"]), report({ result: "fail", fixedFalseApprovals: ["c"], reasons: ["1 new false approval"] }));
    expect((await proposePrompt(worse.deps)).kind).toBe("not_better");
    expect(tie.calls.pr.length + worse.calls.pr.length).toBe(0);

    const win = setup(proposal(["new rule"]), report({ fixedFalseApprovals: ["c"] }));
    expect((await proposePrompt(win.deps)).kind).toBe("pr_opened");
    expect(win.calls.pr).toEqual(["src/agents/prompts.ts"]);
    expect(await proposePrompt(win.deps)).toEqual({ kind: "skipped", why: "weekly_limit" });
    expect(win.calls.pr.length).toBe(1);
  });

  it("drops an oversized or secret-bearing patch before any eval", async () => {
    const big = setup(proposal(Array.from({ length: 200 }, (_, i) => `rule ${i}`)), report({ fixedFalseApprovals: ["c"] }));
    expect((await proposePrompt(big.deps)).kind).toBe("invalid");
    const leaky = setup(proposal([`const key = "${"sk-ant-api03-"}${"a".repeat(40)}";`]), report({ fixedFalseApprovals: ["c"] }));
    expect((await proposePrompt(leaky.deps)).kind).toBe("invalid");
    expect(big.calls.eval + leaky.calls.eval + big.calls.pr.length + leaky.calls.pr.length).toBe(0);
  });
});
