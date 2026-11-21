import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const GATE_BIN = path.resolve("gate/archangel-gate");

function createBuggyGoRemote(): { root: string; remoteBare: string; baseSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-broker-gate-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(path.join(seed, "calc"), { recursive: true });
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seed, "go.mod"), "module example.com/bg\n\ngo 1.26.0\n");
  fs.writeFileSync(
    path.join(seed, "calc", "calc.go"),
    "package calc\n\nfunc Add(a, b int) int { if b < 0 { return a - b }; return a + b }\n",
  );
  fs.writeFileSync(
    path.join(seed, "calc", "calc_test.go"),
    'package calc\n\nimport "testing"\n\nfunc TestPos(t *testing.T) { if Add(1, 2) != 3 { t.Fatal("bad") } }\n',
  );
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  const baseSha = git(seed, ["rev-parse", "HEAD"]);
  git(root, ["clone", "--bare", seed, remoteBare]);
  return { root, remoteBare, baseSha };
}

describe("GitBroker local pre-push archangel-gate (Neon P1)", () => {
  it("passes a valid bugfix + repro test and blocks an already-fixed or broken PR pre-push", async () => {
    expect(fs.existsSync(GATE_BIN)).toBe(true);
    const { root, remoteBare, baseSha } = createBuggyGoRemote();
    try {
      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
        gateBinaryPath: GATE_BIN,
      });
      await broker.ensureBareRepo(remoteBare);

      // 1) Valid bugfix passes local Gate
      const clone1 = await broker.createThrowawayClone(1, baseSha);
      fs.writeFileSync(path.join(clone1, "calc", "calc.go"), "package calc\n\nfunc Add(a, b int) int { return a + b }\n");
      fs.writeFileSync(
        path.join(clone1, "calc", "issue1_test.go"),
        'package calc\n\nimport "testing"\n\nfunc TestIssue1Neg(t *testing.T) { if Add(2, -5) != -3 { t.Fatal("bad") } }\n',
      );
      git(clone1, ["add", "-A"]);
      git(clone1, ["commit", "-m", "fix Add"]);
      const v1 = await broker.fetchAndValidateFromClone(clone1, 1, baseSha);
      expect(v1.gateReport?.passed).toBe(true);
      expect(v1.gateReport?.repro_tests).toEqual(["calc::TestIssue1Neg"]);
      broker.removeClone(clone1);

      // 2) Already-fixed test fails local Gate with already_fixed: true
      const clone2 = await broker.createThrowawayClone(2, baseSha);
      fs.writeFileSync(
        path.join(clone2, "calc", "issue2_test.go"),
        'package calc\n\nimport "testing"\n\nfunc TestIssue2AlreadyOk(t *testing.T) { if Add(2, 3) != 5 { t.Fatal("bad") } }\n',
      );
      git(clone2, ["add", "-A"]);
      git(clone2, ["commit", "-m", "already passing"]);
      const v2 = await broker.fetchAndValidateFromClone(clone2, 2, baseSha);
      expect(v2.gateReport?.passed).toBe(false);
      expect(v2.gateReport?.already_fixed).toBe(true);
      broker.removeClone(clone2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
