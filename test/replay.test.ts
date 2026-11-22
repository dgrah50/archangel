import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";
import { MUTATORS, deriveCases, renderReplay, runReplay } from "../src/core/replay.js";
import { runGate } from "../src/gate/gate.js";
import { Ledger } from "../src/ledger/store.js";

const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};

const POLICY = {
  version: 1,
  gate: {
    maxNonTestLines: 20,
    maxTotalLines: 100,
    maxFiles: 5,
    testFileGlobs: ["tests/*.test.mjs"],
    testCmd: 'for f in tests/*.test.mjs; do node "$f" || exit 1; done',
    protectedPaths: ["lock.json"],
  },
  requiredChecks: ["Gate", "Test"],
};

/** A repo with captured history: a merged fix (#1), a recorded static rejection (#2), an unpinned head (#3), an owner-closed Thread (#4). */
async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-replay-"));
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(work, ["init", "-q", "-b", "main"]);
  write(work, "calc.mjs", "export function add(a, b) {\n  if (b < 0) return a - b;\n  return a + b;\n}\n");
  write(work, "tests/existing.test.mjs", 'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(1, 2), 3);\n');
  write(work, "lock.json", '{"v":1}\n');
  write(work, ".agents/archangel.json", JSON.stringify(POLICY));
  write(work, ".pre-commit-config.yaml", "repos: []\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "base"]);
  const sha = (b: string, msg: string, edit: () => void) => {
    git(work, ["checkout", "-q", "-b", b, "main"]);
    edit();
    git(work, ["add", "-A"]);
    git(work, ["commit", "-qm", msg]);
    const s = git(work, ["rev-parse", "HEAD"]);
    git(work, ["checkout", "-q", "main"]);
    return s;
  };
  const fix = sha("factory/1", "fix", () => {
    write(work, "calc.mjs", "export function add(a, b) {\n  return a + b;\n}\n");
    write(work, "tests/issue1.test.mjs", 'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, -5), -3);\n');
  });
  const protectedTouch = sha("factory/2", "bad", () => write(work, "lock.json", '{"v":2}\n'));
  const unpinned = sha("factory/3", "unpinned", () => write(work, "calc.mjs", "export const x = 1;\n"));
  const closed = sha("factory/4", "closed", () => write(work, "calc.mjs", "export const y = 2;\n"));

  const bare = path.join(root, "broker.git");
  git(root, ["clone", "-q", "--bare", work, bare]);
  const broker = new GitBroker({ bareRepoPath: bare, clonesDir: path.join(root, "clones") });
  for (const [n, s] of [[1, fix], [2, protectedTouch], [4, closed]] as const) await broker.pinEvalRef("acme/app", n, s);

  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const thread = (n: number, phase: object) => ledger.upsertThread({ issueNumber: n, title: `t${n}`, bodySha256: "b", branchName: `factory/${n}`, phase: phase as never, now: 1 });
  thread(1, { kind: "done", outcome: "merged" });
  ledger.recordMerge({ issueNumber: 1, prNumber: 1, headSha: fix, squashSha: "s", shadowOnly: false, mainRequired: ["Test"], now: 1 });
  thread(2, { kind: "needs_you", code: "gate_failed", reason: "r", resumeTo: { kind: "queued" } });
  const a2 = ledger.startAttempt(2, "implement", 1);
  ledger.finishAttempt(a2.id, { status: "failed", headSha: protectedTouch, errorMessage: "protected path modified: lock.json", errorCategory: "static_rejection" }, 2);
  thread(3, { kind: "done", outcome: "merged" });
  ledger.recordMerge({ issueNumber: 3, prNumber: 3, headSha: unpinned, squashSha: "s3", shadowOnly: false, mainRequired: ["Test"], now: 1 });
  thread(4, { kind: "done", outcome: "pr_closed" });
  const a4 = ledger.startAttempt(4, "implement", 1);
  ledger.finishAttempt(a4.id, { status: "succeeded", headSha: closed }, 2);
  return { root, bare, ledger, fix };
}

const run = async (w: Awaited<ReturnType<typeof world>>, over: Partial<Parameters<typeof runReplay>[0]> = {}) =>
  runReplay({ repo: "acme/app", bareRepoPath: w.bare, seeds: w.ledger.listReplaySeeds(0), ...over });

describe("deriveCases (labels come only from the Ledger)", () => {
  it("labels merged-and-clean good; reverted, disputed or red bad; owner-closed bad; recorded static rejections bad", () => {
    const seed = (n: number, phase: object, merges: object[] = [], failed: object[] = [], lastHead: string | null = null) =>
      ({ issueNumber: n, branchName: `factory/${n}`, phase, updatedAt: 1, merges, failedAttempts: failed, lastHead }) as never;
    const cases = deriveCases([
      seed(1, { kind: "done", outcome: "merged" }, [{ headSha: "a", shadowOnly: false, disagreed: false, mainWatch: "green" }]),
      seed(2, { kind: "done", outcome: "owner_merged" }, [{ headSha: "b", shadowOnly: true, disagreed: true, mainWatch: "green" }]),
      seed(3, { kind: "done", outcome: "reverted" }, [{ headSha: "c", shadowOnly: false, disagreed: false, mainWatch: "red" }]),
      seed(4, { kind: "done", outcome: "pr_closed" }, [], [], "d"),
      seed(5, { kind: "queued" }, [], [{ headSha: "e", errorMessage: "protected path modified: x", errorCategory: "static_rejection" }, { headSha: "f", errorMessage: "some model error", errorCategory: "other" }, { headSha: "g", errorMessage: "no new test file added; protected path modified: y", errorCategory: "gate_or_policy" }]),
    ]);
    expect(cases.map((c) => [c.issueNumber, c.kind, c.label])).toEqual([
      [1, "merged_fix", "good"], [2, "merged_fix", "bad"], [3, "merged_fix", "bad"], [4, "owner_closed", "bad"], [5, "rejected_attempt", "bad"],
    ]);
    expect(cases.find((c) => c.issueNumber === 4)!.recorded).toBeNull();
  });
});

describe("replay", () => {
  it("passes when the Gate verdicts still match and every mutant is rejected (with tests)", async () => {
    const w = await world();
    try {
      const r = await run(w, { runTests: true });
      expect(renderReplay(r)).not.toContain("REGRESSION");
      expect(r.regressions).toBe(0);
      const byIssue = (n: number) => r.cases.find((c) => c.issueNumber === n)!;
      expect(byIssue(1)).toMatchObject({ status: "ok", gate: "pass" });
      expect(byIssue(2)).toMatchObject({ status: "ok", gate: "reject" });
      expect(byIssue(3).status).toBe("skipped"); // head not pinned
      expect(byIssue(4)).toMatchObject({ status: "ok", kind: "owner_closed" });
      expect(r.mutants.map((m) => m.mutator).sort()).toEqual(MUTATORS.map((m) => m.name).sort());
      for (const m of r.mutants) expect(m.status, `${m.mutator}: ${m.detail}`).toBe("rejected");
      expect(renderReplay(r)).toContain("No regressions.");
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 120_000);

  it("by default runs no repo tests: static mutants are rejected and the test-dependent ones are reported as skipped", async () => {
    const w = await world();
    try {
      const r = await run(w);
      expect(renderReplay(r)).not.toContain("REGRESSION");
      expect(r.regressions).toBe(0);
      const st = Object.fromEntries(r.mutants.map((m) => [m.mutator, m.status]));
      expect(st["revert-fix-keep-test"]).toBe("skipped");
      expect(st["weaken-test-assertion"]).toBe("skipped");
      for (const n of ["touch-protected-path", "drop-new-tests", "edit-existing-test", "exceed-diff-budget"]) expect(st[n]).toBe("rejected");
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("detects a Gate that would now reject a merged fix", async () => {
    const w = await world();
    try {
      const stricter = async (o: Parameters<typeof runGate>[0]) => {
        const rep = await runGate(o);
        return { ...rep, passed: false, violations: ["changed files 2 exceeds limit 1"] };
      };
      const r = await run(w, { gate: stricter });
      expect(r.cases.find((c) => c.issueNumber === 1)).toMatchObject({ status: "regression" });
      expect(r.cases.find((c) => c.issueNumber === 1)!.detail).toContain("would now REJECT a merged fix");
      expect(r.regressions).toBeGreaterThan(0);
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("detects a Gate that would now accept a rejected diff, and accepts mutants (a loosened Gate)", async () => {
    const w = await world();
    try {
      const looser = async (o: Parameters<typeof runGate>[0]) => ({ ...(await runGate(o)), passed: true, violations: [] });
      const r = await run(w, { gate: looser });
      expect(r.cases.find((c) => c.issueNumber === 2)!.detail).toContain("would now ACCEPT");
      const accepted = r.mutants.filter((m) => m.status === "regression").map((m) => m.mutator).sort();
      expect(accepted).toEqual(["drop-new-tests", "edit-existing-test", "exceed-diff-budget", "touch-protected-path"]);
      expect(r.regressions).toBeGreaterThanOrEqual(5);
      expect(renderReplay(r)).toContain("REGRESSION");
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("never modifies the broker repo", async () => {
    const w = await world();
    try {
      const before = git(w.bare, ["for-each-ref"]);
      await run(w);
      expect(git(w.bare, ["for-each-ref"])).toBe(before);
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("says how many cases were actually replayed, so an all-skipped run cannot read as a clean pass", async () => {
    const w = await world();
    try {
      const r = await run(w);
      expect(r.replayed).toBe(r.cases.filter((c) => c.status !== "skipped").length);
      expect(r.replayed).toBeGreaterThan(0);
      expect(renderReplay(r)).toContain(`replayed ${r.replayed} of ${r.cases.length}`);
      const none = await run(w, { seeds: [] });
      expect(none.replayed).toBe(0);
      expect(renderReplay(none)).toContain("replayed 0 of 0");
      expect(renderReplay(none)).toContain("NOTHING WAS REPLAYED");
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
