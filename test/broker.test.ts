import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { GatePolicySchema } from "../src/config.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best-effort temp cleanup on Linux CI when git helper processes exit slightly late.
  }
}

function createFixtureRemote(): { root: string; remoteBare: string; baseSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-broker-test-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(seed, { recursive: true });

  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seed, "go.mod"), "module example.com/demo\n\ngo 1.26.0\n");
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 1 }\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  const baseSha = git(seed, ["rev-parse", "HEAD"]);

  git(root, ["clone", "--bare", seed, remoteBare]);
  return { root, remoteBare, baseSha };
}

const BOUNDS = GatePolicySchema.parse({});

describe("GitBroker (ADR-0004 B2 isolation)", () => {
  it("isolates throwaway clones, ignores planted hooks, validates paths, and pushes factory/<n>", async () => {
    const { root, remoteBare, baseSha } = createFixtureRemote();
    try {
      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
      });
      await broker.ensureBareRepo(remoteBare);

      const cloneDir = await broker.createThrowawayClone(7, baseSha);
      // Throwaway clone must have zero remotes.
      expect(git(cloneDir, ["remote"])).toBe("");

      // Plant a malicious git hook in the throwaway clone; Broker must NEVER execute it.
      const pwnMarker = path.join(root, "pwned");
      const hookPath = path.join(cloneDir, ".git", "hooks", "pre-push");
      fs.writeFileSync(hookPath, `#!/bin/sh\ntouch "${pwnMarker}"\n`, { mode: 0o755 });

      fs.writeFileSync(path.join(cloneDir, "app.go"), "package demo\n\nfunc Val() int { return 2 }\n");
      git(cloneDir, ["add", "-A"]);
      git(cloneDir, ["commit", "-m", "fix Val"]);

      const val = await broker.fetchAndValidateFromClone(cloneDir, 7, baseSha, BOUNDS);
      expect(val.protectedViolations).toEqual([]);
      expect(val.changedFiles).toEqual(["app.go"]);
      expect(val.nonTestLines).toBe(2);

      // Refuses non-factory branch names
      await expect(broker.pushFactoryBranch("main", val.headSha, remoteBare)).rejects.toThrow(
        /non-factory branch/,
      );

      // Pushes factory/7 cleanly and never ran planted hook
      await broker.pushFactoryBranch("factory/7", val.headSha, remoteBare);
      expect(fs.existsSync(pwnMarker)).toBe(false);
      expect(git(remoteBare, ["rev-parse", "refs/heads/factory/7"])).toBe(val.headSha);

      // Clean merge-tree check
      expect(await broker.isMergeTreeClean(baseSha, val.headSha)).toBe(true);

      // Exact revert branch creation works cleanly
      const rev = await broker.createExactRevertBranch(7, val.headSha, val.headSha);
      expect(rev.branchName).toBe("factory/revert-7");
      const revertedContent = git(broker.bareRepoPath, ["show", `${rev.headSha}:app.go`]);
      expect(revertedContent).toContain("return 1");
    } finally {
      cleanupDir(root);
    }
  });

  it("diffs against merge-base so main advancing on a protected path does not fail an in-flight branch", async () => {
    const { root, remoteBare, baseSha } = createFixtureRemote();
    const seed = path.join(root, "seed");
    try {
      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
      });
      await broker.ensureBareRepo(remoteBare);

      // Branch from original baseSha and edit only app.go
      const cloneDir = await broker.createThrowawayClone(4, baseSha);
      fs.writeFileSync(path.join(cloneDir, "app.go"), "package demo\n\nfunc Val() int { return 3 }\n");
      git(cloneDir, ["add", "-A"]);
      git(cloneDir, ["commit", "-m", "fix app"]);

      // Meanwhile main advances with an edit to a protected workflow file
      fs.mkdirSync(path.join(seed, ".github", "workflows"), { recursive: true });
      fs.writeFileSync(path.join(seed, ".github", "workflows", "archangel-gate.yml"), "name: Gate\n");
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-m", "update gate workflow on main"]);
      git(seed, ["push", remoteBare, "main"]);
      await broker.syncFromRemote(remoteBare);
      const newMainSha = git(remoteBare, ["rev-parse", "refs/heads/main"]);

      const val = await broker.fetchAndValidateFromClone(cloneDir, 4, newMainSha, BOUNDS);
      expect(val.protectedViolations).toEqual([]);
      expect(val.changedFiles).toEqual(["app.go"]);

      // Deterministic Broker rebase onto advanced main preserves only app.go on top of newMainSha
      const rebased = await broker.rebaseCleanOntoMain(4, newMainSha, val.headSha);
      expect(rebased.ok).toBe(true);
      if (rebased.ok) {
        const parents = git(broker.bareRepoPath, ["rev-list", "--parents", "-n", "1", rebased.headSha]);
        expect(parents).toContain(newMainSha);
        const diff = await broker.getDiffAndTouchedFiles(newMainSha, rebased.headSha);
        expect(Object.keys(diff.touchedFiles)).toEqual(["app.go"]);
      }
    } finally {
      cleanupDir(root);
    }
  });

  it("runs .agents/setup strictly from mainSha with scrubbed env and enforces extraProtectedPaths", async () => {
    const { root, remoteBare } = createFixtureRemote();
    const seed = path.join(root, "seed");
    try {
      // Commit .agents/setup on main that writes a marker and verifies GH_TOKEN is absent.
      fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
      fs.writeFileSync(
        path.join(seed, ".agents", "setup"),
        '#!/bin/sh\necho "setup-ok:${GH_TOKEN:-scrubbed}" > .setup-ran\n',
        { mode: 0o755 },
      );
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-m", "add .agents/setup"]);
      git(seed, ["push", remoteBare, "main"]);
      const mainSha = git(remoteBare, ["rev-parse", "refs/heads/main"]);

      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
      });
      await broker.ensureBareRepo(remoteBare);

      const cloneDir = await broker.createThrowawayClone(12, mainSha);
      const setupRes = await broker.runRepoSetup(cloneDir, mainSha);
      expect(setupRes.ran).toBe(true);
      expect(fs.readFileSync(path.join(cloneDir, ".setup-ran"), "utf8").trim()).toBe("setup-ok:scrubbed");

      // Extra protected path check
      fs.mkdirSync(path.join(cloneDir, "migrations"), { recursive: true });
      fs.writeFileSync(path.join(cloneDir, "migrations", "001.sql"), "DROP TABLE x;\n");
      fs.rmSync(path.join(cloneDir, ".setup-ran"));
      git(cloneDir, ["add", "-A"]);
      git(cloneDir, ["commit", "-m", "touch migration"]);
      const val = await broker.fetchAndValidateFromClone(cloneDir, 12, mainSha, { ...BOUNDS, extraProtectedPaths: ["migrations/**"] });
      expect(val.protectedViolations.some((v) => v.includes("migrations/001.sql"))).toBe(true);
    } finally {
      cleanupDir(root);
    }
  });

  it("isMergeTreeClean returns false only on real merge conflicts and throws on git errors", async () => {
    const { root, remoteBare, baseSha } = createFixtureRemote();
    const seed = path.join(root, "seed");
    try {
      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
      });
      await broker.ensureBareRepo(remoteBare);

      // Branch from baseSha editing app.go
      const cloneDir = await broker.createThrowawayClone(20, baseSha);
      fs.writeFileSync(path.join(cloneDir, "app.go"), "package demo\n\nfunc Val() int { return 10 }\n");
      git(cloneDir, ["add", "-A"]);
      git(cloneDir, ["commit", "-m", "branch edit"]);
      const val = await broker.fetchAndValidateFromClone(cloneDir, 20, baseSha, BOUNDS);

      // Advance main with a conflicting edit to app.go
      fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 99 }\n");
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-m", "main conflicting edit"]);
      git(seed, ["push", remoteBare, "main"]);
      await broker.syncFromRemote(remoteBare);
      const conflictMain = git(remoteBare, ["rev-parse", "refs/heads/main"]);

      // Genuine merge conflict returns false
      expect(await broker.isMergeTreeClean(conflictMain, val.headSha)).toBe(false);

      // Missing commit must throw (not look like a merge conflict)
      await expect(broker.isMergeTreeClean(conflictMain, "f".repeat(40))).rejects.toThrow();

      // Unrelated history must throw
      git(seed, ["checkout", "--orphan", "unrelated"]);
      fs.writeFileSync(path.join(seed, "other.txt"), "unrelated\n");
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-m", "orphan"]);
      const orphanSha = git(seed, ["rev-parse", "HEAD"]);
      git(seed, ["push", remoteBare, `${orphanSha}:refs/heads/factory/999`]);
      await broker.syncFromRemote(remoteBare);
      await expect(broker.isMergeTreeClean(conflictMain, orphanSha)).rejects.toThrow();

      // Broken/missing bare repo must throw
      const brokenBroker = new GitBroker({
        bareRepoPath: path.join(root, "missing.git"),
        clonesDir: path.join(root, "clones"),
      });
      await expect(brokenBroker.isMergeTreeClean(baseSha, val.headSha)).rejects.toThrow();
    } finally {
      cleanupDir(root);
    }
  });

  it("hasCommit, pinEvalRef, listFilesAtRef, and rebaseCleanOntoMain throw on broken repo errors instead of returning safe-looking values", async () => {
    const { root, remoteBare, baseSha } = createFixtureRemote();
    const seed = path.join(root, "seed");
    try {
      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
      });
      await broker.ensureBareRepo(remoteBare);

      // Healthy repo: absent commit returns false / null; absent dir returns []
      expect(await broker.hasCommit(baseSha)).toBe(true);
      expect(await broker.hasCommit("f".repeat(40))).toBe(false);
      expect(await broker.pinEvalRef("acme/app", 1, "f".repeat(40))).toBeNull();
      expect(await broker.listFilesAtRef(baseSha, "nonexistent-dir")).toEqual([]);
      expect(await broker.listFilesAtRef(baseSha, ".")).toContain("app.go");

      // Invalid ref on listFilesAtRef must throw (not return [])
      await expect(broker.listFilesAtRef("f".repeat(40), ".")).rejects.toThrow();

      // Genuine rebase conflict still returns { ok: false }
      const cloneDir = await broker.createThrowawayClone(22, baseSha);
      fs.writeFileSync(path.join(cloneDir, "app.go"), "package demo\n\nfunc Val() int { return 77 }\n");
      git(cloneDir, ["add", "-A"]);
      git(cloneDir, ["commit", "-m", "branch edit"]);
      const val = await broker.fetchAndValidateFromClone(cloneDir, 22, baseSha, BOUNDS);
      fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 88 }\n");
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-m", "main edit"]);
      git(seed, ["push", remoteBare, "main"]);
      await broker.syncFromRemote(remoteBare);
      const conflictMain = git(remoteBare, ["rev-parse", "refs/heads/main"]);
      const conflictRebase = await broker.rebaseCleanOntoMain(22, conflictMain, val.headSha);
      expect(conflictRebase.ok).toBe(false);

      // Corrupt/broken bare repo (missing HEAD) must throw across all helpers
      fs.rmSync(path.join(broker.bareRepoPath, "HEAD"));
      await expect(broker.hasCommit(baseSha)).rejects.toThrow();
      await expect(broker.pinEvalRef("acme/app", 1, baseSha)).rejects.toThrow();
      await expect(broker.listFilesAtRef(baseSha, ".")).rejects.toThrow();
      await expect(broker.rebaseCleanOntoMain(22, conflictMain, val.headSha)).rejects.toThrow();
    } finally {
      cleanupDir(root);
    }
  });
});
