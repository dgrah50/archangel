import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Implementer } from "../src/agents/implementer.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { BENCH, parseChain, renderBench, runBenchTiers, type BenchOptions } from "../src/core/bench-tiers.js";
import { saveReport } from "../src/core/eval-reports.js";
import { startUiServer } from "../src/core/ui-server.js";
import { captureAttemptInput, parseAttemptInput } from "../src/core/attempt-input.js";
import { Ledger } from "../src/ledger/store.js";
import type { AddressInfo } from "node:net";

vi.setConfig({ testTimeout: 120_000 });

const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
};
const POLICY = { version: 1, gate: { testFileGlobs: ["tests/*.test.mjs"], testCmd: "true" }, requiredChecks: ["Gate", "Test"] };

async function world(good: number, kind: "implement" | "revise" | "rebase" = "implement") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-bench-test-"));
  const work = path.join(root, "work");
  fs.mkdirSync(work);
  git(work, ["init", "-q", "-b", "main"]);
  write(work, "calc.mjs", "export function add(a, b) {\n  return a - b;\n}\n");
  write(work, "tests/existing.test.mjs", 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n');
  write(work, ".agents/archangel.json", JSON.stringify(POLICY));
  write(work, ".pre-commit-config.yaml", "repos: []\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-qm", "base"]);
  const heads: Record<number, string> = {};
  for (let n = 1; n <= good; n++) {
    git(work, ["checkout", "-q", "-b", `factory/${n}`, "main"]);
    write(work, "calc.mjs", `export function add(a, b) {\n  return a + b; // fix ${n}\n}\n`);
    write(work, `tests/issue${n}.test.mjs`, `import assert from "node:assert/strict";\nassert.equal(${n}, ${n});\n`);
    git(work, ["add", "-A"]);
    git(work, ["commit", "-qm", `fix ${n}`]);
    heads[n] = git(work, ["rev-parse", "HEAD"]);
    git(work, ["checkout", "-q", "main"]);
  }
  // revise and rebase start from a weak head (the fix without its test) the factory produced earlier
  const weak: Record<number, string> = {};
  if (kind !== "implement") {
    for (let n = 1; n <= good; n++) {
      git(work, ["checkout", "-q", "-b", `weak/${n}`, "main"]);
      write(work, "calc.mjs", `export function add(a, b) {\n  return a + b; // weak ${n}\n}\n`);
      git(work, ["add", "-A"]);
      git(work, ["commit", "-qm", `weak ${n}`]);
      weak[n] = git(work, ["rev-parse", "HEAD"]);
      git(work, ["checkout", "-q", "main"]);
    }
  }
  let conflictBase = "";
  if (kind === "rebase") {
    write(work, "other.mjs", "export const other = 1;\n");
    git(work, ["add", "-A"]);
    git(work, ["commit", "-qm", "main moves"]);
    conflictBase = git(work, ["rev-parse", "HEAD"]);
  }
  const bare = path.join(root, "broker.git");
  git(root, ["clone", "-q", "--bare", work, bare]);
  const broker = new GitBroker({ bareRepoPath: bare, clonesDir: path.join(root, "clones") });
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  for (const [n, head] of Object.entries(heads).map(([k, v]) => [Number(k), v] as const)) {
    await broker.pinEvalRef("acme/app", n, head);
    ledger.upsertThread({ issueNumber: n, title: `Bug ${n}`, bodySha256: "b", branchName: `factory/${n}`, now: 1, issueBody: `Issue text ${n}`, phase: { kind: "done", outcome: "merged" } as never });
    const a = ledger.startAttempt(n, "implement", 1);
    ledger.finishAttempt(a.id, { status: "succeeded", headSha: head }, 2);
    if (kind !== "implement") {
      await broker.pinEvalRef("acme/app", n, weak[n]!);
      if (kind === "rebase") await broker.pinEvalRef("acme/app", n, conflictBase);
      const r = ledger.startAttempt(n, kind, 3);
      ledger.recordAttemptInput(
        r.id,
        weak[n]!,
        captureAttemptInput(kind, {
          mainSha: conflictBase,
          gateViolations: ["no new test file added matching tests/*.test.mjs"],
          structuredFindings: [{ vendor: "openai", findings: [{ file: "calc.mjs", severity: "major", summary: "add a test for the fix" }] }],
        }),
      );
      ledger.finishAttempt(r.id, { status: "succeeded", headSha: head }, 4);
    }
    ledger.recordMerge({ issueNumber: n, prNumber: n, headSha: head, squashSha: "s", shadowOnly: false, mainRequired: ["Test"], now: 1 });
  }
  return { root, bare, ledger, sources: () => [{ repo: "acme/app", bareRepoPath: bare, seeds: ledger.listReplaySeeds(0, "acme/app"), attemptInputs: ledger.listAttemptInputs("acme/app") }] };
}
const cleanup = (w: { root: string; ledger: Ledger }) => {
  w.ledger.close();
  fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
};

/** A chain whose first provider is `agy` writes the fix and a test; `codex` writes only the fix (the static Gate rejects it); `claude` throws. */
function fakeImplementers(counts: { runs: Record<string, number>; prompts?: string[] }): BenchOptions["implementerFor"] {
  return (chain) => {
    const who = chain[0]!.provider;
    const impl: Implementer = {
      async run(input) {
        counts.runs[who] = (counts.runs[who] ?? 0) + 1;
        counts.prompts?.push(input.prompt);
        if (who === "claude") throw new Error("provider down");
        write(input.cloneDir, "calc.mjs", `export function add(a, b) {\n  return a + b;\n}\n`);
        if (who === "agy") write(input.cloneDir, `tests/new${input.issueNumber}.test.mjs`, 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n');
        return { summary: "", costUsd: 0, transcriptPath: null, aborted: false, providersUsed: ["openai"] };
      },
    };
    return impl;
  };
}

const base = (w: Awaited<ReturnType<typeof world>>, over: Partial<BenchOptions> & { counts: { runs: Record<string, number>; prompts?: string[] } }): BenchOptions => ({
  ledger: w.ledger,
  sources: w.sources(),
  role: "implement",
  currentChain: [{ provider: "codex" }],
  candidateChain: [{ provider: "agy", model: "big" }],
  implementerFor: fakeImplementers(over.counts),
  ...over,
});

describe("bench-tiers", () => {
  it("parses a chain spec and rejects an unknown provider or empty entry", () => {
    expect(parseChain("codex:gpt-5-mini, agy")).toEqual([{ provider: "codex", model: "gpt-5-mini" }, { provider: "agy" }]);
    expect(() => parseChain("nope")).toThrow();
    expect(() => parseChain("codex,")).toThrow();
  });

  it("scores each chain mechanically with the Gate, reports the verdict, and prints a snippet", async () => {
    const w = await world(5);
    try {
      const counts = { runs: {} as Record<string, number> };
      const r = await runBenchTiers(base(w, { counts }));
      expect(r.comparable).toBe(5);
      expect(r.current).toMatchObject({ scored: 5, passRate: 0 }); // no new test: the static Gate rejects it
      console.log(JSON.stringify(r.perCase[0]));
      expect(r.candidate).toMatchObject({ scored: 5, passRate: 1 });
      expect(r.candidate.meanDiffLines).toBeGreaterThan(0);
      expect(r.verdict).toBe("matched_or_beat");
      expect(r.verdictLine).toBe("candidate matched or beat current on 5/5 cases (pass rate 1 vs 0)");
      expect(r.snippet).toBe("chains:\n  implement:\n    - provider: agy\n      model: big");
      expect(renderBench(r)).toContain("never edits it");
      expect(r.perCase[0]!.current!.violations.join(" ")).toMatch(/no new test file/i);
    } finally {
      cleanup(w);
    }
  });

  it("a candidate that does worse is not recommended and gets no snippet", async () => {
    const w = await world(5);
    try {
      const counts = { runs: {} as Record<string, number> };
      const r = await runBenchTiers(base(w, { counts, currentChain: [{ provider: "agy" }], candidateChain: [{ provider: "codex" }] }));
      expect(r.verdict).toBe("worse");
      expect(r.snippet).toBeNull();
      expect(r.verdictLine).toContain("not recommended");
    } finally {
      cleanup(w);
    }
  });

  it("says insufficient data below 5 comparable cases, and leaves out a case where a chain errored", async () => {
    const w = await world(4);
    try {
      const counts = { runs: {} as Record<string, number> };
      const few = await runBenchTiers(base(w, { counts }));
      expect(few.verdict).toBe("insufficient");
      expect(few.verdictLine).toContain("at least 5 are required");
      expect(few.snippet).toBeNull();
      const down = await runBenchTiers(base(w, { counts, candidateChain: [{ provider: "claude" }] }));
      expect(down.candidate).toMatchObject({ scored: 0, errors: 4 });
      expect(down.comparable).toBe(0);
    } finally {
      cleanup(w);
    }
  });

  it("caches results per (chain, case), never caches an error, and honours the case cap", async () => {
    const w = await world(6);
    try {
      const counts = { runs: {} as Record<string, number> };
      const first = await runBenchTiers(base(w, { counts, maxCases: 5 }));
      expect(first.selected).toBe(5);
      expect(counts.runs).toEqual({ codex: 5, agy: 5 });
      const second = await runBenchTiers(base(w, { counts, maxCases: 5 }));
      expect(counts.runs).toEqual({ codex: 5, agy: 5 }); // no new real runs
      expect(second.cacheHits).toBe(10);
      await runBenchTiers(base(w, { counts, candidateChain: [{ provider: "claude" }], maxCases: 5 }));
      await runBenchTiers(base(w, { counts, candidateChain: [{ provider: "claude" }], maxCases: 5 }));
      expect(counts.runs.claude).toBe(10); // errors are retried, not cached
      expect(BENCH.defaultMaxCases).toBe(6);
      const def = await runBenchTiers(base(w, { counts }));
      expect(def.selected).toBe(6);
    } finally {
      cleanup(w);
    }
  });

  it("replays captured revisions with their findings and Gate violations, scored by the Gate", async () => {
    const w = await world(5, "revise");
    try {
      const counts = { runs: {} as Record<string, number>, prompts: [] as string[] };
      const r = await runBenchTiers(base(w, { counts, role: "revise" }));
      expect(r.comparable).toBe(5);
      expect(r.current).toMatchObject({ passRate: 0 });
      expect(r.candidate).toMatchObject({ passRate: 1 });
      expect(r.verdict).toBe("matched_or_beat");
      expect(r.snippet).toContain("  revise:");
      expect(counts.prompts[0]).toContain("Revision Attempt");
      expect(counts.prompts[0]).toContain("add a test for the fix"); // the captured finding
      expect(counts.prompts[0]).toContain("no new test file added"); // the captured Gate violation
    } finally {
      cleanup(w);
    }
  });

  it("replays captured LLM rebases from the pre-rebase head against the conflicting base", async () => {
    const w = await world(5, "rebase");
    try {
      const counts = { runs: {} as Record<string, number>, prompts: [] as string[] };
      const r = await runBenchTiers(base(w, { counts, role: "rebase" }));
      expect(r.comparable).toBe(5);
      expect(r.candidate).toMatchObject({ passRate: 1 });
      expect(counts.prompts[0]).toContain("Rebase Attempt");
      expect(r.perCase[0]!.id).toMatch(/:rebase\d+$/);
    } finally {
      cleanup(w);
    }
  });

  it("an implement-only world has no revise cases: insufficient data, no runs", async () => {
    const w = await world(5);
    try {
      const counts = { runs: {} as Record<string, number> };
      const r = await runBenchTiers(base(w, { counts, role: "revise" }));
      expect(r.verdict).toBe("insufficient");
      expect(counts.runs).toEqual({});
    } finally {
      cleanup(w);
    }
  });

  it("captured inputs are structured and bounded, drop secrets, and exist only for revise and rebase", () => {
    const longText = "x".repeat(5000);
    const json = captureAttemptInput("revise", {
      mainSha: "a".repeat(40),
      gateViolations: Array.from({ length: 30 }, () => longText),
      structuredFindings: [{ vendor: "openai", findings: [{ file: "a.ts", severity: "major", summary: longText, suggestion: "do it" }] }],
    })!;
    const parsed = parseAttemptInput(json)!;
    expect(parsed.kind === "revise" && parsed.gateViolations).toHaveLength(10);
    expect(parsed.kind === "revise" && parsed.gateViolations[0]!.length).toBe(300);
    expect(parsed.kind === "revise" && parsed.findings[0]!.findings[0]!.summary.length).toBe(400);
    expect(captureAttemptInput("implement", { mainSha: "a".repeat(40), gateViolations: [], structuredFindings: [] })).toBeNull();
    expect(captureAttemptInput("revise", { mainSha: "a".repeat(40), gateViolations: ["token ghp_" + "a".repeat(36)], structuredFindings: [] })).toBeNull();
    expect(captureAttemptInput("rebase", { mainSha: "a".repeat(40), gateViolations: [], structuredFindings: [] })).toBe(JSON.stringify({ kind: "rebase", conflictBase: "a".repeat(40) }));
    expect(parseAttemptInput("{not json")).toBeNull();
    expect(parseAttemptInput(JSON.stringify({ kind: "revise", findings: [], gateViolations: [], log: "raw" }))).not.toBeNull(); // unknown keys are dropped by the schema, never stored
  });

  it("never edits archangel.yaml or the live Broker repo, and the report is listed by /api/evals", async () => {
    const w = await world(5);
    try {
      const cfg = path.join(w.root, "archangel.yaml");
      fs.writeFileSync(cfg, "chains:\n  implement:\n    - provider: codex\n");
      const before = fs.readFileSync(cfg, "utf8");
      const refsBefore = git(w.bare, ["for-each-ref"]);
      const counts = { runs: {} as Record<string, number> };
      const r = await runBenchTiers(base(w, { counts }));
      expect(fs.readFileSync(cfg, "utf8")).toBe(before);
      expect(git(w.bare, ["for-each-ref"])).toBe(refsBefore);
      // saved through the shared report store, so the Evals page lists it
      const dataDir = path.join(w.root, "data");
      saveReport(dataDir, "bench-tiers", r, 1_800_000_000_000);
      const ui = path.join(w.root, "ui");
      fs.mkdirSync(ui);
      fs.writeFileSync(path.join(ui, "index.html"), "<html><head></head></html>");
      const server = await startUiServer(new Ledger(":memory:"), { host: "127.0.0.1", port: 0, uiDir: ui, dataDir });
      try {
        const body = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/evals`)).json()) as { runs: Array<Record<string, unknown>> };
        expect(body.runs).toHaveLength(1);
        expect(body.runs[0]).toMatchObject({ kind: "bench-tiers", unreadable: false, verdict: "pass", role: "implement", comparable: 5, matchedOrBeat: 5, verdictLine: r.verdictLine });
      } finally {
        server.close();
      }
    } finally {
      cleanup(w);
    }
  });
});
