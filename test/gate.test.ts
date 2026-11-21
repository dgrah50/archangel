import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";
import { runGate } from "../src/gate/gate.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

/**
 * Creates a minimal language-agnostic Node repo whose verification rules live 100% inside
 * `.pre-commit-config.yaml` and `.agents/landing.json` on `main`.
 */
function createRepoFixture(): { root: string; repoDir: string; baseSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-gate-test-"));
  const repoDir = path.join(root, "repo");
  fs.mkdirSync(repoDir, { recursive: true });

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "Test"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);

  // Buggy add(): subtracts when b < 0
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
  writeFile(
    repoDir,
    ".pre-commit-config.yaml",
    [
      "repos:",
      "  - repo: local",
      "    hooks:",
      "      - id: no-banned-marker",
      "        name: Ban SKIP_ALL or EVAL_HACK",
      "        entry: bash -c 'if grep -nE \"SKIP_ALL|EVAL_HACK\" \"$@\"; then echo \"banned marker\"; exit 1; fi' --",
      "        language: system",
      "        files: '\\.mjs$'",
    ].join("\n") + "\n",
  );
  writeFile(
    repoDir,
    ".agents/landing.json",
    JSON.stringify(
      {
        maxNonTestLines: 20,
        maxTotalLines: 100,
        maxFiles: 5,
        testFileGlobs: ["tests/*.test.mjs"],
        // Syntax-check all .mjs files on base to prove new test imports/compiles cleanly against base
        testBuildCmd:
          "node -e 'const fs=require(\"fs\"); for (const f of fs.readdirSync(\"tests\")) { const s=fs.readFileSync(\"tests/\"+f,\"utf8\"); if (s.includes(\"NONEXISTENT_API\")) process.exit(1); }'",
        testCmd: 'for f in tests/*.test.mjs; do node "$f" || exit 1; done',
        baseTestRuns: 2,
        headTestRuns: 2,
        extraProtectedPaths: ["lock.json"],
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

describe("language-agnostic Gate (repo-owned .pre-commit-config.yaml + .agents/landing.json)", () => {
  it("passes a valid bugfix + new test file and runs repo pre-commit hooks from base", async () => {
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
      const headSha = git(repoDir, ["rev-parse", "HEAD"]);

      const rep = await runGate({ repoDir, baseRef: baseSha, headRef: headSha, policyFromBase: true });
      expect(rep.passed).toBe(true);
      expect(rep.new_test_files).toEqual(["tests/issue1.test.mjs"]);
      expect(rep.hooks_run).toEqual(["no-banned-marker"]);
      expect(rep.violations).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("rejects modifying an existing test file, pre-commit hook failure, tampering with .pre-commit-config.yaml, and base build failure", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    try {
      // 1) Modifying pre-existing test file is rejected
      git(repoDir, ["checkout", "-b", "edit-existing-test", baseSha]);
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  return a + b;\n}\n");
      writeFile(repoDir, "tests/existing.test.mjs", "// weakened\n");
      writeFile(
        repoDir,
        "tests/issue2.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, -5), -3);\n',
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "weaken existing test"]);
      const r1 = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD", policyFromBase: true });
      expect(r1.passed).toBe(false);
      expect(r1.violations.some((v) => v.includes("existing test file modified"))).toBe(true);

      // 2) Repo .pre-commit-config.yaml hook failure blocks PR
      git(repoDir, ["checkout", "-b", "hook-fail", baseSha]);
      writeFile(repoDir, "calc.mjs", "// SKIP_ALL\nexport function add(a, b) {\n  return a + b;\n}\n");
      writeFile(
        repoDir,
        "tests/issue3.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, -5), -3);\n',
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "banned marker"]);
      const r2 = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD", policyFromBase: true });
      expect(r2.passed).toBe(false);
      expect(r2.violations.some((v) => v.includes("pre-commit hook 'no-banned-marker' failed"))).toBe(true);

      // 3) Tampering with .pre-commit-config.yaml or extraProtectedPaths (lock.json) is rejected
      git(repoDir, ["checkout", "-b", "tamper-pc", baseSha]);
      writeFile(repoDir, ".pre-commit-config.yaml", "repos: []\n");
      writeFile(repoDir, "lock.json", '{"v":2}\n');
      writeFile(
        repoDir,
        "tests/issue4.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, -5), -3);\n',
      );
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "tamper pre-commit"]);
      const r3 = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD", policyFromBase: true });
      expect(r3.passed).toBe(false);
      expect(r3.violations.some((v) => v.includes(".pre-commit-config.yaml"))).toBe(true);
      expect(r3.violations.some((v) => v.includes("lock.json"))).toBe(true);

      // 4) Build failure on base does NOT count as a valid red repro
      git(repoDir, ["checkout", "-b", "base-build-fail", baseSha]);
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  return a + b;\n}\n");
      writeFile(repoDir, "tests/issue5.test.mjs", "// uses NONEXISTENT_API\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "new api"]);
      const r4 = await runGate({ repoDir, baseRef: baseSha, headRef: "HEAD", policyFromBase: true });
      expect(r4.passed).toBe(false);
      expect(r4.violations.some((v) => v.includes("base build failed"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("flags already_fixed via GitBroker pre-push Gate and enforces exact-inverse revert ancestry", async () => {
    const { root, repoDir, baseSha } = createRepoFixture();
    const remoteBare = path.join(root, "remote.git");
    git(root, ["clone", "--bare", repoDir, remoteBare]);
    try {
      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
        enableLocalGate: true,
      });
      await broker.ensureBareRepo(remoteBare);

      // Already-passing test on base -> already_fixed: true pre-push!
      const cloneDir = await broker.createThrowawayClone(7, baseSha);
      writeFile(
        cloneDir,
        "tests/issue7.test.mjs",
        'import assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\nassert.equal(add(2, 3), 5);\n',
      );
      git(cloneDir, ["add", "-A"]);
      git(cloneDir, ["commit", "-m", "already passing"]);
      const val = await broker.fetchAndValidateFromClone(cloneDir, 7, baseSha);
      expect(val.gateReport?.passed).toBe(false);
      expect(val.gateReport?.already_fixed).toBe(true);
      broker.removeClone(cloneDir);

      // Exact-inverse revert passes when ancestor of base, fails when non-ancestor
      git(repoDir, ["checkout", "main"]);
      writeFile(repoDir, "calc.mjs", "export function add(a, b) {\n  return a + b;\n}\n");
      git(repoDir, ["add", "-A"]);
      git(repoDir, ["commit", "-m", "squash commit"]);
      const squashSha = git(repoDir, ["rev-parse", "HEAD"]);

      git(repoDir, ["revert", "--no-edit", squashSha]);
      const revertHead = git(repoDir, ["rev-parse", "HEAD"]);
      const okRev = await runGate({
        repoDir,
        baseRef: squashSha,
        headRef: revertHead,
        revertOf: squashSha,
        policyFromBase: true,
      });
      expect(okRev.passed).toBe(true);
      expect(okRev.revert_exempt).toBe(true);

      const badRev = await runGate({
        repoDir,
        baseRef: baseSha,
        headRef: revertHead,
        revertOf: squashSha,
        policyFromBase: true,
      });
      expect(badRev.passed).toBe(false);
      expect(badRev.violations.some((v) => v.includes("not an ancestor"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
