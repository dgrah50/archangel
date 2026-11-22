import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkflow } from "../src/core/workflow.js";
import { runGate } from "../src/gate/gate.js";
import { attributableTo, parseJunit } from "../src/gate/junit.js";
import { hostInput, workflowJson } from "./helpers/workflow.js";

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
  const gate = () => runGate({ repoDir: repo, baseRef: base, headRef: "HEAD", policyFromBase: true, skipPreCommit: true, baseRunsOverride: 1, headRunsOverride: 1 });
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

  it("rejects a base run that failed only for an unrelated reason, while the old exit-code rule would have accepted it", async () => {
    // The new test already passes on base, and a different existing test fails in the overlaid run (flaky/environment).
    const files = { "tests/neg.test.mjs": 'console.log("ok negative");\n' };
    const withJunit = fixture({ flakyOnOverlay: true });
    const without = fixture({ flakyOnOverlay: true, junit: null });
    try {
      withJunit.commit(files);
      without.commit(files);
      const strict = await withJunit.gate();
      expect(strict.passed).toBe(false);
      expect(strict.violations.join(" ")).toContain("unrelated to the new tests");
      expect(strict.already_fixed).toBe(false);
      // junitReport unset: behaviour is exactly as before (any non-zero base exit counts as red).
      const legacy = await without.gate();
      expect(legacy.passed).toBe(true);
      expect(legacy.proof?.junit).toBeUndefined();
    } finally {
      cleanup(withJunit.root);
      cleanup(without.root);
    }
  });

  it("still reports already_fixed when the new test passes on base and nothing else failed", async () => {
    const f = fixture();
    try {
      f.commit({ "tests/neg.test.mjs": 'console.log("ok negative");\n' });
      const r = await f.gate();
      expect(r.passed).toBe(false);
      expect(r.already_fixed).toBe(true);
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

describe("JUnit parsing and attribution conventions", () => {
  const files = ["tests/neg.test.mjs", "pkg/store/store_test.go"];
  const one = (attrs: string, suite = "s") => parseJunit(`<testsuites><testsuite name="${suite}"><testcase ${attrs}/></testsuite></testsuites>`)![0]!;

  it("attributes Vitest/Playwright (file path in classname), file attributes, and Go package classnames", () => {
    expect(attributableTo(one('classname="tests/neg.test.mjs" name="a"'), files)).toBe(true);
    expect(attributableTo(one('classname="/work/repo/tests/neg.test.mjs" name="a"'), files)).toBe(true);
    expect(attributableTo(one('classname="x" file="./tests/neg.test.mjs" name="a"'), files)).toBe(true);
    expect(attributableTo(one('classname="neg.test.mjs" name="a"'), files)).toBe(false); // bare name: not a path
    expect(attributableTo(one('classname="github.com/acme/app/pkg/store" name="TestPut"'), files)).toBe(true);
    expect(attributableTo(one('classname="github.com/acme/app/pkg/other" name="TestPut"'), files)).toBe(false);
    expect(attributableTo(one('name="TestPut"', "github.com/acme/app/pkg/store"), files)).toBe(true); // suite name fallback
    expect(attributableTo(one('classname="com.example.Suite" name="a"'), files)).toBe(false);
  });

  it("reads failure, error, skipped and self-closing cases, and ignores tags inside CDATA and comments", () => {
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="s">
      <testcase classname="a" name="p"/>
      <testcase classname="a" name="f"><failure message="x">boom</failure></testcase>
      <testcase classname="a" name="e"><error/></testcase>
      <testcase classname="a" name="s"><skipped/></testcase>
      <system-out><![CDATA[<testcase classname="a" name="fake"/>]]></system-out>
      <!-- <testcase classname="a" name="commented"/> -->
    </testsuite></testsuites>`;
    expect(parseJunit(xml)!.map((c) => `${c.name}:${c.status}`)).toEqual(["p:passed", "f:failed", "e:failed", "s:skipped"]);
  });

  it("returns null for non-JUnit or truncated documents", () => {
    expect(parseJunit("hello")).toBeNull();
    expect(parseJunit('<testsuites><testsuite><testcase name="a"><failure>')).toBeNull();
  });
});

describe("junitReport schema validation (kernel)", () => {
  const resolveWith = (junitReport: unknown) =>
    resolveWorkflow(hostInput(), {
      repo: "a/b",
      mainSha: "m",
      fileRaw: workflowJson([], { gate: { testFileGlobs: ["t/*.ts"], testCmd: "npm test", junitReport } }),
      scoutPrompts: {},
    });

  it("accepts a safe relative glob and rejects absolute paths, traversal, backslashes and odd characters", () => {
    expect(resolveWith("reports/junit*.xml").status).toBe("ok");
    expect(resolveWith("**/junit.xml").status).toBe("ok");
    for (const bad of ["/etc/junit.xml", "../junit.xml", "a/../../b.xml", "a\\b.xml", "r/$(x).xml", "", " "]) {
      expect(resolveWith(bad).status, JSON.stringify(bad)).toBe("invalid");
    }
  });
});
