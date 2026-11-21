import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { GatePolicy } from "../config.js";
import {
  isProtectedPath,
  isTestOrFixtureFile,
  runGate,
  type GateReport,
} from "../gate/gate.js";

export { isProtectedPath };
export type LocalGateReport = GateReport;

const execFileAsync = promisify(execFile);

const HARDENED_GIT_FLAGS = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "transfer.fsckObjects=true",
  "-c",
  "fetch.fsckObjects=true",
  "-c",
  "protocol.file.allow=always",
];

const FACTORY_BRANCH_RE = /^factory\/(?:revert-)?\d+$/;

export interface BrokerFetchValidation {
  headSha: string;
  changedFiles: string[];
  protectedViolations: string[];
  nonTestLines: number;
  totalLines: number;
  diffText: string;
  touchedFiles: Record<string, string>;
  gateReport?: LocalGateReport;
}

export interface GitBrokerOptions {
  bareRepoPath: string;
  clonesDir: string;
  defaultBranch?: string;
  maxNonTestLines?: number;
  maxTotalLines?: number;
  maxFiles?: number;
  extraProtectedPaths?: string[];
  testFileGlobs?: string[];
  testDataGlobs?: string[];
  testBuildCmd?: string;
  testCmd?: string;
  enableLocalGate?: boolean;
  localGateTimeoutMs?: number;
}

export type ValidationBounds = Partial<GatePolicy>;

/**
 * Hardened Git Broker (ADR-0004 B2):
 * - Owns its own bare clone (`broker.git`) that the implementer never has write access to.
 * - Creates isolated throwaway clones (never shared worktrees) with no push remotes for the implementer.
 * - Runs optional `.agents/setup` read strictly from `main` tip with a scrubbed environment.
 * - Fetches commits out of the throwaway clone into the bare clone with hooks/fsmonitor disabled,
 *   validates protected paths, diff bounds, and optional in-process language-agnostic Gate
 *   (repo `.pre-commit-config.yaml` + red-on-base/green-on-head `testCmd`), and pushes only `factory/<n>`.
 */
export class GitBroker {
  readonly bareRepoPath: string;
  readonly clonesDir: string;
  readonly defaultBranch: string;
  readonly maxNonTestLines: number;
  readonly maxTotalLines: number;
  readonly maxFiles: number;
  readonly extraProtectedPaths: string[];
  readonly testFileGlobs: string[];
  readonly testDataGlobs: string[];
  readonly testBuildCmd?: string;
  readonly testCmd?: string;
  readonly enableLocalGate: boolean;
  readonly localGateTimeoutMs: number;

  constructor(opts: GitBrokerOptions) {
    this.bareRepoPath = path.resolve(opts.bareRepoPath);
    this.clonesDir = path.resolve(opts.clonesDir);
    this.defaultBranch = opts.defaultBranch ?? "main";
    this.maxNonTestLines = opts.maxNonTestLines ?? 150;
    this.maxTotalLines = opts.maxTotalLines ?? 300;
    this.maxFiles = opts.maxFiles ?? 5;
    this.extraProtectedPaths = opts.extraProtectedPaths ?? [];
    this.testFileGlobs = opts.testFileGlobs ?? [];
    this.testDataGlobs = opts.testDataGlobs ?? [];
    this.testBuildCmd = opts.testBuildCmd;
    this.testCmd = opts.testCmd;
    this.enableLocalGate = opts.enableLocalGate ?? false;
    this.localGateTimeoutMs = opts.localGateTimeoutMs ?? 180_000;
  }

  private async runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    };
    const { stdout } = await execFileAsync("git", [...HARDENED_GIT_FLAGS, ...args], {
      cwd,
      env: cleanEnv,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  }

  async ensureBareRepo(remoteUrl: string): Promise<void> {
    fs.mkdirSync(path.dirname(this.bareRepoPath), { recursive: true });
    if (!fs.existsSync(this.bareRepoPath)) {
      await this.runGit(path.dirname(this.bareRepoPath), [
        "clone",
        "--bare",
        remoteUrl,
        this.bareRepoPath,
      ]);
      // Never retain embedded token URLs inside bare repo config.
      await this.runGit(this.bareRepoPath, ["remote", "remove", "origin"]);
      return;
    }
    await this.syncFromRemote(remoteUrl);
  }

  async syncFromRemote(remoteUrl: string): Promise<void> {
    await this.runGit(this.bareRepoPath, [
      "fetch",
      "--prune",
      remoteUrl,
      `+refs/heads/${this.defaultBranch}:refs/heads/${this.defaultBranch}`,
      "+refs/heads/factory/*:refs/heads/factory/*",
    ]);
  }

  async resolveRef(ref: string): Promise<string> {
    return (await this.runGit(this.bareRepoPath, ["rev-parse", ref])).trim();
  }

  /**
   * Creates an isolated throwaway clone for the implementer with no remote credentials.
   */
  async createThrowawayClone(issueNumber: number, startRef: string): Promise<string> {
    fs.mkdirSync(this.clonesDir, { recursive: true });
    const cloneDir = path.join(this.clonesDir, `issue-${issueNumber}-${Date.now()}`);
    await this.runGit(this.clonesDir, ["clone", "--no-local", this.bareRepoPath, cloneDir]);
    await this.runGit(cloneDir, ["checkout", "-B", `factory/${issueNumber}`, startRef]);
    await this.runGit(cloneDir, ["remote", "remove", "origin"]);
    await this.runGit(cloneDir, ["config", "user.name", "Archangel Worker"]);
    await this.runGit(cloneDir, ["config", "user.email", "archangel-worker@users.noreply.github.com"]);
    return cloneDir;
  }

  /**
   * Reads a file directly from the broker's bare repo at a trusted ref (e.g. `main` tip).
   * Returns null if the file does not exist at that ref.
   */
  async readFileAtRef(ref: string, relPath: string): Promise<string | null> {
    try {
      return await this.runGit(this.bareRepoPath, ["show", `${ref}:${relPath}`]);
    } catch {
      return null;
    }
  }

  /**
   * Runs the repository's `.agents/setup` script inside a fresh throwaway clone,
   * reading the script bytes strictly from `mainSha` (never from a PR branch)
   * under a scrubbed environment with no credentials.
   */
  async runRepoSetup(
    cloneDir: string,
    mainSha: string,
    timeoutMs = 5 * 60_000,
  ): Promise<{ ran: boolean; stdout: string }> {
    const script = await this.readFileAtRef(mainSha, ".agents/setup");
    if (!script || !script.trim()) {
      return { ran: false, stdout: "" };
    }
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const { stdout } = await execFileAsync("/bin/sh", ["-eu", "-c", script], {
      cwd: cloneDir,
      env: cleanEnv,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ran: true, stdout };
  }

  /**
   * Executes the language-agnostic Archangel Gate strictly against `this.bareRepoPath`
   * (never against the implementer clone), reading `.agents/landing.json` and
   * `.pre-commit-config.yaml` strictly from `baseSha`.
   */
  async runLocalGate(
    baseSha: string,
    headSha: string,
    bounds?: ValidationBounds,
  ): Promise<LocalGateReport> {
    return runGate({
      repoDir: this.bareRepoPath,
      baseRef: baseSha,
      headRef: headSha,
      policy: {
        maxNonTestLines: bounds?.maxNonTestLines ?? this.maxNonTestLines,
        maxTotalLines: bounds?.maxTotalLines ?? this.maxTotalLines,
        maxFiles: bounds?.maxFiles ?? this.maxFiles,
        extraProtectedPaths: bounds?.extraProtectedPaths ?? this.extraProtectedPaths,
        testFileGlobs: bounds?.testFileGlobs ?? this.testFileGlobs,
        testDataGlobs: bounds?.testDataGlobs ?? this.testDataGlobs,
        testBuildCmd: bounds?.testBuildCmd ?? this.testBuildCmd,
        testCmd: bounds?.testCmd ?? this.testCmd,
      },
      policyFromBase: true,
      baseRunsOverride: 1,
      headRunsOverride: 1,
      commandTimeoutMs: this.localGateTimeoutMs,
    });
  }

  /**
   * Hardened fetch from an untrusted throwaway clone into the broker's bare repo,
   * followed by protected-path, diff-bound, and optional local Gate verification inside the bare repo.
   */
  async fetchAndValidateFromClone(
    cloneDir: string,
    issueNumber: number,
    baseSha: string,
    bounds?: ValidationBounds,
  ): Promise<BrokerFetchValidation> {
    const maxNonTestLines = bounds?.maxNonTestLines ?? this.maxNonTestLines;
    const maxTotalLines = bounds?.maxTotalLines ?? this.maxTotalLines;
    const maxFiles = bounds?.maxFiles ?? this.maxFiles;
    const extraProtectedPaths = bounds?.extraProtectedPaths ?? this.extraProtectedPaths;
    const testFileGlobs = bounds?.testFileGlobs ?? this.testFileGlobs;
    const testDataGlobs = bounds?.testDataGlobs ?? this.testDataGlobs;

    const stagingRef = `refs/archangel/staging/${issueNumber}`;
    await this.runGit(this.bareRepoPath, ["fetch", cloneDir, `+HEAD:${stagingRef}`]);
    const headSha = await this.resolveRef(stagingRef);

    const numstat = await this.runGit(this.bareRepoPath, [
      "diff",
      "--numstat",
      "--no-renames",
      baseSha,
      headSha,
    ]);
    const changedFiles: string[] = [];
    const protectedViolations: string[] = [];
    let nonTestLines = 0;
    let totalLines = 0;

    for (const line of numstat.trim().split("\n")) {
      if (!line) continue;
      const parts = line.split("\t");
      const filePath = parts[2];
      if (!filePath) continue;
      changedFiles.push(filePath);
      if (isProtectedPath(filePath, extraProtectedPaths)) {
        protectedViolations.push(`protected path modified: ${filePath}`);
      }
      if (parts[0] === "-" || parts[1] === "-") {
        protectedViolations.push(`binary file modified: ${filePath}`);
        continue;
      }
      const lines = Number(parts[0] ?? 0) + Number(parts[1] ?? 0);
      totalLines += lines;
      if (!isTestOrFixtureFile(filePath, { testFileGlobs, testDataGlobs })) {
        nonTestLines += lines;
      }
    }

    if (changedFiles.length === 0) {
      protectedViolations.push("diff is empty");
    }
    if (changedFiles.length > maxFiles) {
      protectedViolations.push(`changed files ${changedFiles.length} exceeds limit ${maxFiles}`);
    }
    if (nonTestLines > maxNonTestLines) {
      protectedViolations.push(
        `non-test changed lines ${nonTestLines} exceeds limit ${maxNonTestLines}`,
      );
    }
    if (totalLines > maxTotalLines) {
      protectedViolations.push(`total changed lines ${totalLines} exceeds limit ${maxTotalLines}`);
    }

    const diffText = await this.runGit(this.bareRepoPath, [
      "diff",
      "--no-color",
      baseSha,
      headSha,
    ]);

    const touchedFiles: Record<string, string> = {};
    for (const filePath of changedFiles.slice(0, 10)) {
      try {
        touchedFiles[filePath] = await this.runGit(this.bareRepoPath, [
          "show",
          `${headSha}:${filePath}`,
        ]);
      } catch {
        // File may have been deleted; omit content.
      }
    }

    let gateReport: LocalGateReport | undefined;
    if (this.enableLocalGate && protectedViolations.length === 0) {
      gateReport = await this.runLocalGate(baseSha, headSha, bounds);
    }

    return {
      headSha,
      changedFiles,
      protectedViolations,
      nonTestLines,
      totalLines,
      diffText,
      touchedFiles,
      gateReport,
    };
  }

  /**
   * Pushes a validated commit strictly to `factory/<issue>` or `factory/revert-<issue>`.
   */
  async pushFactoryBranch(branchName: string, headSha: string, remoteUrl: string): Promise<void> {
    if (!FACTORY_BRANCH_RE.test(branchName)) {
      throw new Error(`Broker refused push to non-factory branch: ${branchName}`);
    }
    await this.runGit(this.bareRepoPath, [
      "push",
      "--force-with-lease",
      remoteUrl,
      `${headSha}:refs/heads/${branchName}`,
    ]).catch(async () => {
      await this.runGit(this.bareRepoPath, [
        "push",
        "--force",
        remoteUrl,
        `${headSha}:refs/heads/${branchName}`,
      ]);
    });
    await this.runGit(this.bareRepoPath, ["update-ref", `refs/heads/${branchName}`, headSha]);
  }

  /**
   * Reads unified diff and full touched file contents directly from the broker's bare repo.
   */
  async getDiffAndTouchedFiles(
    baseSha: string,
    headSha: string,
  ): Promise<{ diffText: string; touchedFiles: Record<string, string> }> {
    const diffText = await this.runGit(this.bareRepoPath, [
      "diff",
      "--no-color",
      baseSha,
      headSha,
    ]);
    const filesRaw = await this.runGit(this.bareRepoPath, [
      "diff",
      "--name-only",
      "--no-renames",
      baseSha,
      headSha,
    ]);
    const touchedFiles: Record<string, string> = {};
    for (const filePath of filesRaw.trim().split("\n").filter(Boolean).slice(0, 10)) {
      try {
        touchedFiles[filePath] = await this.runGit(this.bareRepoPath, [
          "show",
          `${headSha}:${filePath}`,
        ]);
      } catch {
        // Deleted file
      }
    }
    return { diffText, touchedFiles };
  }

  /**
   * Checks whether `headSha` merges cleanly onto `baseSha` without modifying any working tree.
   */
  async isMergeTreeClean(baseSha: string, headSha: string): Promise<boolean> {
    try {
      await this.runGit(this.bareRepoPath, ["merge-tree", "--write-tree", baseSha, headSha]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Creates an exact-inverse revert commit of a recorded factory squash-merge SHA on top of baseSha.
   */
  async createExactRevertBranch(
    issueNumber: number,
    baseSha: string,
    squashSha: string,
  ): Promise<{ branchName: string; headSha: string }> {
    const branchName = `factory/revert-${issueNumber}`;
    const tmpDir = path.join(this.clonesDir, `revert-${issueNumber}-${Date.now()}`);
    fs.mkdirSync(this.clonesDir, { recursive: true });
    try {
      await this.runGit(this.clonesDir, ["clone", "--no-local", this.bareRepoPath, tmpDir]);
      await this.runGit(tmpDir, ["checkout", "-B", branchName, baseSha]);
      await this.runGit(tmpDir, ["config", "user.name", "Archangel Lander"]);
      await this.runGit(tmpDir, ["config", "user.email", "archangel-lander@users.noreply.github.com"]);
      await this.runGit(tmpDir, ["revert", "--no-edit", squashSha]);
      await this.runGit(this.bareRepoPath, [
        "fetch",
        tmpDir,
        `+HEAD:refs/heads/${branchName}`,
      ]);
      const headSha = await this.resolveRef(`refs/heads/${branchName}`);
      return { branchName, headSha };
    } finally {
      this.removeClone(tmpDir);
    }
  }

  removeClone(cloneDir: string): void {
    if (cloneDir && fs.existsSync(cloneDir)) {
      fs.rmSync(cloneDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}
