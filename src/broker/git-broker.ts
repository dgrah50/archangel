import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

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

const PROTECTED_PREFIXES = [".github/", "scripts/", "vendor/", ".agents/"];
const PROTECTED_EXACT = new Set([
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "claude.md",
  "agents.md",
  "makefile",
  "gnumakefile",
  ".gitattributes",
  ".gitmodules",
  ".editorconfig",
  ".golangci.yml",
  ".golangci.yaml",
  ".golangci.toml",
  ".golangci.json",
  ".pre-commit-config.yaml",
]);

export function isProtectedPath(relPath: string, extraProtectedPaths: string[] = []): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);
  if (PROTECTED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (PROTECTED_EXACT.has(lower) || PROTECTED_EXACT.has(base)) return true;
  if (base.startsWith("license") || base.startsWith("copying")) return true;
  if (base.startsWith(".goreleaser") || base.startsWith(".golangci")) return true;
  if (lower.includes("/.git/") || lower === ".git") return true;
  for (const rawPattern of extraProtectedPaths) {
    const pat = rawPattern.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    if (!pat) continue;
    if (pat.endsWith("/**")) {
      const prefix = pat.slice(0, -2); // keep trailing "/"
      if (lower.startsWith(prefix)) return true;
    } else if (pat.endsWith("/")) {
      if (lower.startsWith(pat)) return true;
    } else if (lower === pat) {
      return true;
    }
  }
  return false;
}

export function isTestOrFixturePath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return p.endsWith("_test.go") || p.startsWith("testdata/") || p.includes("/testdata/");
}

export interface BrokerFetchValidation {
  headSha: string;
  changedFiles: string[];
  protectedViolations: string[];
  nonTestLines: number;
  totalLines: number;
  diffText: string;
  touchedFiles: Record<string, string>;
}

export interface GitBrokerOptions {
  bareRepoPath: string;
  clonesDir: string;
  defaultBranch?: string;
  maxNonTestLines?: number;
  maxTotalLines?: number;
  maxFiles?: number;
  extraProtectedPaths?: string[];
}

export interface ValidationBounds {
  maxNonTestLines?: number;
  maxTotalLines?: number;
  maxFiles?: number;
  extraProtectedPaths?: string[];
}

/**
 * Hardened Git Broker (ADR-0004 B2):
 * - Owns its own bare clone (`broker.git`) that the implementer never has write access to.
 * - Creates isolated throwaway clones (never shared worktrees) with no push remotes for the implementer.
 * - Runs optional `.agents/setup` read strictly from `main` tip with a scrubbed environment.
 * - Fetches commits out of the throwaway clone into the bare clone with hooks/fsmonitor disabled,
 *   validates protected paths and diff bounds in the bare clone, and pushes only `factory/<n>` branches.
 */
export class GitBroker {
  readonly bareRepoPath: string;
  readonly clonesDir: string;
  readonly defaultBranch: string;
  readonly maxNonTestLines: number;
  readonly maxTotalLines: number;
  readonly maxFiles: number;
  readonly extraProtectedPaths: string[];

  constructor(opts: GitBrokerOptions) {
    this.bareRepoPath = path.resolve(opts.bareRepoPath);
    this.clonesDir = path.resolve(opts.clonesDir);
    this.defaultBranch = opts.defaultBranch ?? "main";
    this.maxNonTestLines = opts.maxNonTestLines ?? 150;
    this.maxTotalLines = opts.maxTotalLines ?? 300;
    this.maxFiles = opts.maxFiles ?? 5;
    this.extraProtectedPaths = opts.extraProtectedPaths ?? [];
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
    // Strip origin so the clone has zero remote pointers.
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
   * under a scrubbed environment with no credentials (Polaris contract + ADR-0004).
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
      GOTOOLCHAIN: "local",
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
   * Hardened fetch from an untrusted throwaway clone into the broker's bare repo,
   * followed by protected-path and diff-bound inspection inside the broker's bare repo.
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
      if (!isTestOrFixturePath(filePath)) {
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

    return {
      headSha,
      changedFiles,
      protectedViolations,
      nonTestLines,
      totalLines,
      diffText,
      touchedFiles,
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
      // First push when remote branch doesn't exist yet or force-pushing a rebased factory branch.
      await this.runGit(this.bareRepoPath, [
        "push",
        "--force",
        remoteUrl,
        `${headSha}:refs/heads/${branchName}`,
      ]);
    });
    // Record local branch ref in broker's bare repo so subsequent clones/reverts can always resolve it.
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
