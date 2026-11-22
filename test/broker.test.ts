import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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

      const val = await broker.fetchAndValidateFromClone(cloneDir, 7, baseSha);
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
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("rejects protected paths pre-push inside broker bare clone", async () => {
    const { root, remoteBare, baseSha } = createFixtureRemote();
    try {
      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
      });
      await broker.ensureBareRepo(remoteBare);

      const cloneDir = await broker.createThrowawayClone(9, baseSha);
      fs.mkdirSync(path.join(cloneDir, ".github", "workflows"), { recursive: true });
      fs.writeFileSync(path.join(cloneDir, ".github", "workflows", "archangel-gate.yml"), "name: Evil\n");
      git(cloneDir, ["add", "-A"]);
      git(cloneDir, ["commit", "-m", "edit gate"]);

      const val = await broker.fetchAndValidateFromClone(cloneDir, 9, baseSha);
      expect(val.protectedViolations.some((v) => v.includes("protected path modified"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

      const val = await broker.fetchAndValidateFromClone(cloneDir, 4, newMainSha);
      expect(val.protectedViolations).toEqual([]);
      expect(val.changedFiles).toEqual(["app.go"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
        extraProtectedPaths: ["migrations/**"],
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
      const val = await broker.fetchAndValidateFromClone(cloneDir, 12, mainSha);
      expect(val.protectedViolations.some((v) => v.includes("migrations/001.sql"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
