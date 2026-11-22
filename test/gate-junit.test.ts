import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { runGate } from "../src/gate/gate.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (root: string, rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content, "utf8");
};

/**
 * A tiny test runner that writes JUnit like the real reporters do (classname = file path). Each test file prints TAP-ish lines
 * ("ok x" / "not ok x"), one test case per line. Mode switches let each scenario break the report in a specific way.
 */
const runner = (mode: "normal" | "garbage" | "weird-classname") => `
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const files = fs.readdirSync("tests").filter((f) => f.endsWith(".test.mjs")).sort();
let cases = "";
let failed = false;
for (const f of files) {
  let out = "";
  try { out = execFileSync("node", ["tests/" + f], { encoding: "utf8" }); } catch (e) { out = String(e.stdout ?? ""); failed = true; }
  for (const line of out.split("\\n")) {
    const m = /^(not ok|ok) (.+)$/.exec(line);
    if (!m) continue;
    const cn = ${mode === "weird-classname" ? '"com.example.Suite"' : '"tests/" + f'};
    cases += '<testcase classname="' + cn + '" name="' + m[2] + '">' + (m[1] === "not ok" ? '<failure message="x"/>' : "") + "</testcase>";
    if (m[1] === "not ok") failed = true;
  }
}
fs.mkdirSync("reports", { recursive: true });
fs.writeFileSync("reports/junit.xml", ${mode === "garbage" ? '"<<< not xml"' : '"<testsuites><testsuite name=\\"s\\">" + cases + "</testsuite></testsuites>"'});
process.exit(failed ? 1 : 0);
`;

interface Opts {
  junit?: string | null;
  mode?: "normal" | "garbage" | "weird-classname";
  /** An existing test that only fails in the overlaid base run (environment noise unrelated to the new test). */
  flakyOnOverlay?: boolean;
}

function fixture(o: Opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-gate-junit-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "T"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  write(repo, "calc.mjs", "export function add(a, b) {\n  if (b < 0) return a - b;\n  return a + b;\n}\n");
  write(repo, "scripts/run-tests.mjs", runner(o.mode ?? "normal"));
  write(repo, "tests/existing.test.mjs", 'console.log("ok existing");\n');
  if (o.flakyOnOverlay) {
    write(repo, "tests/flaky.test.mjs", 'if (process.env.ARCHANGEL_NEW_TEST_FILES && process.cwd().endsWith("/base")) { console.log("not ok flaky"); } else { console.log("ok flaky"); }\n');
  }
  write(
    repo,
    ".agents/archangel.json",
    JSON.stringify({
      version: 1,
      gate: {
        testFileGlobs: ["tests/*.test.mjs"],
        testCmd: "node scripts/run-tests.mjs",
        ...(o.junit === null ? {} : { junitReport: o.junit ?? "reports/junit.xml" }),
      },
      requiredChecks: ["Gate", "Test"],
    }),
  );
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  const commit = (files: Record<string, string>) => {
    for (const [f, c] of Object.entries(files)) write(repo, f, c);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "change"]);
  };
  const gate = () => runGate({ repoDir: repo, baseRef: base, headRef: "HEAD", skipPreCommit: true, baseRunsOverride: 1, headRunsOverride: 1 });
  return { root, commit, gate };
}

const FIXED_ADD = "export function add(a, b) {\n  return a + b;\n}\n";
const NEW_TEST = [
  'import { add } from "../calc.mjs";',
  'console.log(add(2, -5) === -3 ? "ok negative" : "not ok negative");',
  'console.log(add(1, 1) === 2 ? "ok positive" : "not ok positive");',
].join("\n");

const cleanup = (root: string) => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

describe("Gate JUnit test-ID diffing", () => {
  it("accepts a base failure in a new test file and records the matched test IDs in the proof", async () => {
    const f = fixture();
    try {
      f.commit({ "calc.mjs": FIXED_ADD, "tests/neg.test.mjs": NEW_TEST });
      const r = await f.gate();
      expect(r.violations).toEqual([]);
      expect(r.passed).toBe(true);
      expect(r.proof?.junit?.base_failed).toEqual(["tests/neg.test.mjs::negative"]);
      expect(r.proof?.junit?.head_passed.sort()).toEqual(["tests/neg.test.mjs::negative", "tests/neg.test.mjs::positive"]);
    } finally {
      cleanup(f.root);
    }
  });

  it("rejects a base run that failed only for an unrelated reason", async () => {
    // The new test already passes on base, and a different existing test fails in the overlaid run (flaky/environment).
    const f = fixture({ flakyOnOverlay: true });
    try {
      f.commit({ "tests/neg.test.mjs": 'console.log("ok negative");\n' });
      const r = await f.gate();
      expect(r.passed).toBe(false);
      expect(r.violations.join(" ")).toContain("unrelated to the new tests");
      expect(r.already_fixed).toBe(false);
    } finally {
      cleanup(f.root);
    }
  });

  it("rejects a head run that lacks a passing result for a case that was red on base", async () => {
    const f = fixture();
    try {
      // `skipNeg` makes the head run omit the case entirely instead of passing it.
      const test = [
        'import * as m from "../calc.mjs";',
        'const r = m.add(2, -5);',
        'if (r !== -3) console.log("not ok negative"); else if (!m.skipNeg) console.log("ok negative");',
        'console.log("ok positive");',
      ].join("\n");
      f.commit({ "calc.mjs": `${FIXED_ADD}export const skipNeg = true;\n`, "tests/neg.test.mjs": test });
      const r = await f.gate();
      expect(r.passed).toBe(false);
      expect(r.violations.join(" ")).toContain("lacks a passing result for new test case(s): tests/neg.test.mjs::negative");
    } finally {
      cleanup(f.root);
    }
  });

  it("fails closed on an unparseable report, a missing report, and unattributable cases", async () => {
    const garbage = fixture({ mode: "garbage" });
    const missing = fixture({ junit: "nowhere/*.xml" });
    const weird = fixture({ mode: "weird-classname" });
    try {
      for (const f of [garbage, missing, weird]) f.commit({ "calc.mjs": FIXED_ADD, "tests/neg.test.mjs": NEW_TEST });
      const g = await garbage.gate();
      expect(g.passed).toBe(false);
      expect(g.violations.join(" ")).toMatch(/JUnit report unusable.*not parseable/);
      const m = await missing.gate();
      expect(m.passed).toBe(false);
      expect(m.violations.join(" ")).toMatch(/JUnit report unusable.*no JUnit report was produced/);
      const w = await weird.gate();
      expect(w.passed).toBe(false);
      expect(w.violations.join(" ")).toContain("attributable to the new test files");
    } finally {
      for (const f of [garbage, missing, weird]) cleanup(f.root);
    }
  });

  it("ignores a report committed by the PR (stale or forged): only what the run wrote counts", async () => {
    const f = fixture();
    try {
      const forged = '<testsuites><testsuite name="s"><testcase classname="tests/neg.test.mjs" name="negative"><failure/></testcase></testsuite></testsuites>';
      // The new test passes on base; a committed report claiming a failure must not turn that into a red.
      f.commit({ "tests/neg.test.mjs": 'console.log("ok negative");\n', "reports/junit.xml": forged });
      const r = await f.gate();
      expect(r.passed).toBe(false);
      expect(r.already_fixed).toBe(true);
    } finally {
      cleanup(f.root);
    }
  });
});
