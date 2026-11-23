import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { GatePolicySchema } from "../src/config.js";
import { removeTempTree, runGate } from "../src/gate/gate.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function createRepoFixture(): { root: string; repoDir: string; baseSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-gate-test-"));
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "Test"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);

  writeFile(
    repoDir,
    "calc.mjs",
    "export function add(a, b) {\n  if (b < 0) return a - b;\n  return a + b;\n}\n",
  );
  writeFile(
    repoDir,
    "tests/existing.test.mjs",
    'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(1, 2), 3);\n',
  );
  writeFile(repoDir, "testdata/golden.txt", "expected=3\n");
  writeFile(
    repoDir,
    ".pre-commit-config.yaml",
    [
      "repos:",
      "  - repo: local",
      "    hooks:",
      "      - id: no-banned-marker",
      "        name: Ban SKIP_ALL",
      "        entry: bash -c 'if grep -nE \"SKIP_ALL\" \"$@\"; then echo \"banned marker\"; exit 1; fi' --",
      "        language: system",
      "        files: '\\.mjs$'",
    ].join("\n") + "\n",
  );
  writeFile(
    repoDir,
    ".agents/archangel.json",
    JSON.stringify(
      {
        version: 1,
        gate: {
          maxNonTestLines: 20,
          maxTotalLines: 100,
          maxFiles: 5,
          testFileGlobs: ["tests/*.test.mjs"],
          testDataGlobs: ["testdata/**"],
          testBuildCmd:
            "node -e 'const fs=require(\"fs\"); for (const f of fs.readdirSync(\"tests\")) { const s=fs.readFileSync(\"tests/\"+f,\"utf8\"); if (s.includes(\"NONEXISTENT_API\")) process.exit(1); }'",
          testCmd: 'for f in tests/*.test.mjs; do node "$f" || exit 1; done',
          baseTestRuns: 3,
          headTestRuns: 2,
          protectedPaths: ["lock.json"],
        },
        requiredChecks: ["Gate", "Test"],
      },
      null,
      2,
    ),
  );
  writeFile(repoDir, "lock.json", '{"v":1}\n');

  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-m", "initial"]);
  const baseSha = git(repoDir, ["rev-parse", "HEAD"]);
  return { root, repoDir, baseSha };
}

describe("language-agnostic Gate (hardened post-Opus review)", () => {
  it("passes a valid bugfix + new test file and verifies pristine-base-green -> overlaid-base-red -> head-green", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    try {
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  return a + b;\n}\n");
      writeFile(
        repoDir,
        "tests/issue1.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, -5), -3);\n',
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "fix add"]);

      const rep = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD" });
      expect(rep.passed).toBe(true);
      expect(rep.new_test_files).toEqual(["tests/issue1.test.mjs"]);
      expect(rep.hooks_run).toEqual(["no-banned-marker"]);
      expect(rep.violations).toEqual([]);
      // Reproduction-test output is captured for the Recap: red on base, green on head.
      expect(rep.proof?.base_output).toBeTruthy();
      expect(rep.proof?.head_output).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("blocks existing test/fixture edits, hook failures, mutating hooks, tampering, broken base, and base build failures", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    try {
      // 1) Modifying existing test file OR existing testdata fixture is rejected
      git(repoDir, ["checkout", "-b", "edit-existing", baseSha]);
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  return a + b;\n}\n");
      writeFile(repoDir, "tests/existing.test.mjs", "// weakened\n");
      writeFile(repoDir, "testdata/golden.txt", "tampered=999\n");
      writeFile(
        repoDir,
        "tests/issue2.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, -5), -3);\n',
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "weaken existing test + golden"]);
      const r1 = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD" });
      expect(r1.passed).toBe(false);
      expect(r1.violations.some((v) => v.includes("existing test file modified"))).toBe(true);
      expect(r1.violations.some((v) => v.includes("existing test fixture modified"))).toBe(true);

      // 2) Pre-commit hook failure blocks PR
      git(repoDir, ["checkout", "-b", "hook-fail", baseSha]);
      writeFile(repoDir, "calc.mjs", "// SKIP_ALL\nexport function add(a, b) {\n  return a + b;\n}\n");
      writeFile(
        repoDir,
        "tests/issue3.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, -5), -3);\n',
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "banned marker"]);
      const r2 = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD" });
      expect(r2.passed).toBe(false);
      expect(r2.violations.some((v) => v.includes("pre-commit hook 'no-banned-marker' failed"))).toBe(true);

      // 3) Tampering with .pre-commit-config.yaml or extraProtectedPaths is rejected
      git(repoDir, ["checkout", "-b", "tamper-pc", baseSha]);
      writeFile(repoDir, ".pre-commit-config.yaml", "repos: []\n");
      writeFile(repoDir, "lock.json", '{"v":2}\n');
      writeFile(
        repoDir,
        "tests/issue4.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, -5), -3);\n',
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "tamper"]);
      const r3 = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD" });
      expect(r3.passed).toBe(false);
      expect(r3.violations.some((v) => v.includes(".pre-commit-config.yaml"))).toBe(true);
      expect(r3.violations.some((v) => v.includes("lock.json"))).toBe(true);

      // 4) Build failure on base does NOT count as a valid red repro
      git(repoDir, ["checkout", "-b", "base-build-fail", baseSha]);
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  return a + b;\n}\n");
      writeFile(repoDir, "tests/issue5.test.mjs", "// uses NONEXISTENT_API\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "new api"]);
      const r4 = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD" });
      expect(r4.passed).toBe(false);
      expect(r4.violations.some((v) => v.includes("base build failed"))).toBe(true);

      // 5) Broken pristine base cannot pass red-on-base with a trivial test!
      git(repoDir, ["checkout", "-b", "red-base", baseSha]);
      writeFile(repoDir, "calc.mjs", "export function add() { return -999; }\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "break base"]);
      const redBase = git(repoDir, ["rev-parse", "HEAD"]);
      writeFile(repoDir, "calc.mjs", "export function add(a, b) { return a + b; }\n");
      writeFile(repoDir, "tests/issue6.test.mjs", 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n');
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "trivial test on red base"]);
      const r5 = await runGate({ repoDir, baseRef: redBase, headRef: "HEAD" });
      expect(r5.passed).toBe(false);
      expect(r5.violations.some((v) => v.includes("pristine base testCmd failed"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("fails closed on missing/typo'd archangel.json, unsupported pre-commit keys, and mutating hooks (H3)", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    try {
      // Missing archangel.json fails closed
      git(repoDir, ["checkout", "-b", "no-landing", baseSha]);
      fs.rmSync(path.join(repoDir, ".agents/archangel.json"));
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "drop archangel.json"]);
      const noLandingBase = git(repoDir, ["rev-parse", "HEAD"]);
      writeFile(repoDir, "calc.mjs", "export function add(a, b) { return a + b; }\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "fix"]);
      const rMissing = await runGate({ repoDir, baseRef: noLandingBase, headRef: "HEAD" });
      expect(rMissing.passed).toBe(false);
      expect(rMissing.violations.some((v) => v.includes("missing .agents/archangel.json"))).toBe(true);

      // Anything but a valid version 1 workflow (typo'd key, old flat format, out-of-kernel value) fails closed
      git(repoDir, ["checkout", "-b", "typo-landing", baseSha]);
      writeFile(repoDir, ".agents/archangel.json", JSON.stringify({ testCommand: "true", testFileGlobs: ["tests/*.test.mjs"] }));
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "typo"]);
      const typoBase = git(repoDir, ["rev-parse", "HEAD"]);
      writeFile(repoDir, "tests/t.test.mjs", "export {};\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "test"]);
      const rTypo = await runGate({ repoDir, baseRef: typoBase, headRef: "HEAD" });
      expect(rTypo.passed).toBe(false);
      expect(rTypo.violations.some((v) => v.includes("not a valid workflow"))).toBe(true);

      // A kernel-bound violation (maxFiles above the kernel maximum) is invalid, never clamped
      git(repoDir, ["checkout", "-b", "loose-landing", baseSha]);
      const loose = JSON.parse(fs.readFileSync(path.join(repoDir, ".agents/archangel.json"), "utf8"));
      loose.gate.maxFiles = 50;
      writeFile(repoDir, ".agents/archangel.json", JSON.stringify(loose));
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "loosen"]);
      const looseBase = git(repoDir, ["rev-parse", "HEAD"]);
      writeFile(repoDir, "tests/l.test.mjs", "export {};\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "test"]);
      const rLoose = await runGate({ repoDir, baseRef: looseBase, headRef: "HEAD" });
      expect(rLoose.passed).toBe(false);
      expect(rLoose.violations.some((v) => v.includes("gate.maxFiles"))).toBe(true);

      // Unsupported pre-commit hook key (`args`) or mutating hook fails closed
      git(repoDir, ["checkout", "-b", "mutating-hook", baseSha]);
      writeFile(
        repoDir,
        ".pre-commit-config.yaml",
        [
          "repos:",
          "  - repo: local",
          "    hooks:",
          "      - id: mutator",
          "        entry: bash -c 'echo mutated >> \"$1\"' --",
          "        language: system",
          "        files: '\\.mjs$'",
          "      - id: unsupported-args",
          "        entry: true",
          "        language: system",
          "        args: ['--strict']",
        ].join("\n") + "\n",
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "bad hooks"]);
      const badHookBase = git(repoDir, ["rev-parse", "HEAD"]);
      writeFile(repoDir, "calc.mjs", "export function add(a, b) { return a + b; }\n");
      writeFile(
        repoDir,
        "tests/issue8.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, -5), -3);\n',
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "fix"]);
      const rHook = await runGate({ repoDir, baseRef: badHookBase, headRef: "HEAD" });
      expect(rHook.passed).toBe(false);
      expect(rHook.violations.some((v) => v.includes("unsupported key(s) [args]"))).toBe(true);
      expect(rHook.violations.some((v) => v.includes("mutated file"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("supports staging-SHA revision clone (H4), flags already_fixed pre-push, and blocks multi-commit reverts (H5)", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    const remoteBare = path.join(root, "remote.git");
    git(root, ["clone", "--bare", repoDir, remoteBare]);
    try {
      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
        enableLocalGate: true,
        localGateSkipTests: false,
      });
      await broker.ensureBareRepo(remoteBare);

      // 1) Already-passing test fails local Gate -> staging SHA can be checked out into a revision clone (H4)!
      const cloneDir = await broker.createThrowawayClone(7, baseSha);
      writeFile(
        cloneDir,
        "tests/issue7.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, 3), 5);\n',
      );
      git(cloneDir, ["add", "-A"]);
      git(cloneDir, ["commit", "-m", "already passing"]);
      const val = await broker.fetchAndValidateFromClone(cloneDir, 7, baseSha, GatePolicySchema.parse({}));
      expect(val.gateReport?.passed).toBe(false);
      expect(val.gateReport?.already_fixed).toBe(true);
      broker.removeClone(cloneDir);

      // Verify revision clone can check out the unpushed staging SHA (H4)!
      const revClone = await broker.createThrowawayClone(7, val.headSha);
      expect(git(revClone, ["rev-parse", "HEAD"])).toBe(val.headSha);
      broker.removeClone(revClone);

      // 2) Exact-inverse revert passes ONLY when revertOf === base tip (H5 blocks multi-commit rollback)
      git(repoDir, ["checkout", "main"]);
      writeFile(repoDir, "calc.mjs", "export function add(a, b) { return a + b; }\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "squash commit"]);
      const squashSha = git(repoDir, ["rev-parse", "HEAD"]);

      writeFile(repoDir, "later.txt", "subsequent main commit\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "later commit on main"]);
      const laterMain = git(repoDir, ["rev-parse", "HEAD"]);

      // Build a branch whose tree matches squashSha^ (would silently erase `later.txt`!)
      git(repoDir, ["checkout", "-b", "sneaky-rollback", squashSha]);
      git(repoDir, ["revert", "--no-edit", squashSha]);
      const revertHead = git(repoDir, ["rev-parse", "HEAD"]);

      // Valid when base === squashSha
      const okRev = await runGate({
        repoDir,
        baseRef: squashSha,
        headRef: revertHead,
        revertOf: squashSha,
      });
      expect(okRev.passed).toBe(true);
      expect(okRev.revert_exempt).toBe(true);

      // Rejected when base has advanced past squashSha (H5)
      const badRev = await runGate({
        repoDir,
        baseRef: laterMain,
        headRef: revertHead,
        revertOf: squashSha,
      });
      expect(badRev.passed).toBe(false);
      expect(badRev.violations.some((v) => v.includes("must match base tip"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("Gate work classes", () => {
  const passingTest =
    'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(1, 1), 2);\n';

  it("feature with no new test file passes the Gate", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    try {
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  return a + b;\n}\nexport const VERSION = 2;\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "feature without test"]);

      const feature = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD", workClass: "feature" });
      expect(feature.violations).toEqual([]);
      expect(feature.passed).toBe(true);

    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("chore needs no new test but fails when the existing suite is red on head", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    try {
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  if (b < 0) return a - b;\n  return a + b;\n}\nexport const VERSION = 2;\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "chore green"]);
      const green = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD", workClass: "chore" });
      expect(green.violations).toEqual([]);
      expect(green.passed).toBe(true);

      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  return a - b;\n}\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "chore red"]);
      const red = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD", workClass: "chore" });
      expect(red.passed).toBe(false);
      expect(red.violations.join("\n")).toContain("head testCmd failed");
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("feature skips the red-on-base proof; bugfix (default) still rejects a test that passes on base", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    try {
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  if (b < 0) return a - b;\n  return a + b;\n}\nexport const VERSION = 2;\n");
      writeFile(repoDir, "tests/feature.test.mjs", passingTest);
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "feature"]);

      const bugfix = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD" });
      expect(bugfix.passed).toBe(false);
      expect(bugfix.already_fixed).toBe(true);

      const explicitBugfix = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD", workClass: "bugfix" });
      expect(explicitBugfix.passed).toBe(false);

      const feature = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD", workClass: "feature" });
      expect(feature.violations).toEqual([]);
      expect(feature.passed).toBe(true);
      expect(feature.new_test_files).toEqual(["tests/feature.test.mjs"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

});

describe("Gate policyRef", () => {
  it("reads the policy from policyRef (the current main tip) instead of the diff base", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    try {
      // The branch is cut from baseSha (policy: maxFiles 5), then main tightens the policy to maxFiles 1.
      git(repoDir, ["checkout", "-q", "-b", "branch", baseSha]);
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  return a + b;\n}\n");
      writeFile(
        repoDir,
        "tests/issue.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, -5), -3);\n',
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-qm", "fix"]);
      const head = git(repoDir, ["rev-parse", "HEAD"]);
      git(repoDir, ["checkout", "-q", "main"]);
      const policy = JSON.parse(fs.readFileSync(path.join(repoDir, ".agents/archangel.json"), "utf8"));
      policy.gate.maxFiles = 1;
      writeFile(repoDir, ".agents/archangel.json", JSON.stringify(policy));
      git(repoDir, ["commit", "-qam", "tighten policy on main"]);
      const mainTip = git(repoDir, ["rev-parse", "HEAD"]);

      const old = await runGate({ repoDir, baseRef: baseSha, headRef: head, skipPreCommit: true, skipTests: true });
      expect(old.violations).toEqual([]); // judged by the merge-base's looser policy
      const current = await runGate({ repoDir, baseRef: baseSha, headRef: head, policyRef: mainTip, skipPreCommit: true, skipTests: true });
      expect(current.passed).toBe(false);
      expect(current.violations.join(" ")).toContain("exceeds limit 1");
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("Gate red-on-base proof", () => {
  it("does not accept a base test run that timed out as a reproduction (only a real failing exit is red)", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    try {
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  return a + b;\n}\n");
      // On base (buggy add) this test hangs forever; on head it passes at once.
      const pidFile = path.join(root, "hang.pid");
      writeFile(
        repoDir,
        "tests/hang.test.mjs",
        `import fs from "node:fs";\nimport { add } from "../calc.mjs";\nif (add(2, -5) !== -3) { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); }\n`,
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "fix with a test that hangs on base"]);
      const rep = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD", commandTimeoutMs: 2500 });
      expect(rep.passed).toBe(false);
      expect(rep.violations.join(" ")).toContain("timed out");
      expect(rep.already_fixed).toBe(false);
      // The timeout must kill the whole process group, not just the shell: the runner the shell started is dead too.
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      await new Promise((r) => setTimeout(r, 500));
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 60_000);
});

describe("removeTempTree", () => {
  it("removes a read-only tree like Go's module cache", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-gate-ro-"));
    const mod = path.join(dir, "home", "go", "pkg", "mod", ".github");
    fs.mkdirSync(mod, { recursive: true });
    fs.writeFileSync(path.join(mod, "ci.yml"), "x");
    fs.chmodSync(path.join(mod, "ci.yml"), 0o444);
    for (const d of [mod, path.join(dir, "home", "go", "pkg", "mod"), path.join(dir, "home", "go", "pkg"), path.join(dir, "home", "go"), path.join(dir, "home")]) fs.chmodSync(d, 0o555);
    removeTempTree(dir);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
