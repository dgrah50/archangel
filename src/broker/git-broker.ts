import type { WorkClass } from "../core/work-class.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_SLUG_RE, type GatePolicy } from "../config.js";
import {
  getDiffStats,
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
  "gc.auto=0",
  "-c",
  "transfer.fsckObjects=true",
  "-c",
  "fetch.fsckObjects=true",
  "-c",
  "protocol.file.allow=always",
];

const FACTORY_BRANCH_RE = /^factory\/(?:revert-|feature-)?\d+$/;

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
  enableLocalGate?: boolean;
  localGateSkipTests?: boolean;
  localGateTimeoutMs?: number;
}

/**
 * Hardened Git Broker (ADR-0004 B2):
 * - Owns its own bare clone (`broker.git`) that the implementer never has write access to.
 * - Creates isolated throwaway clones (never shared worktrees) with no push remotes for the implementer.
 * - Runs optional `.agents/setup` read strictly from `main` tip with a throwaway HOME and scrubbed env.
 * - Fetches commits out of the throwaway clone into the bare clone with hooks/fsmonitor disabled,
 *   validates protected paths, diff bounds, and optional in-process language-agnostic Gate, and pushes only `factory/<n>`.
 */
export class GitBroker {
  readonly bareRepoPath: string;
  readonly clonesDir: string;
  readonly defaultBranch: string;
  readonly enableLocalGate: boolean;
  readonly localGateSkipTests: boolean;
  readonly localGateTimeoutMs: number;

  constructor(opts: GitBrokerOptions) {
    this.bareRepoPath = path.resolve(opts.bareRepoPath);
    this.clonesDir = path.resolve(opts.clonesDir);
    this.defaultBranch = opts.defaultBranch ?? "main";
    this.enableLocalGate = opts.enableLocalGate ?? false;
    this.localGateSkipTests = opts.localGateSkipTests ?? false;
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

  /**
   * Keeps `sha` alive under `refs/archangel/eval/<repo>/<issue>/<n>` in the bare repo, so pruning a merged
   * `factory/*` branch on GitHub (the fetch above uses --prune) never loses a commit replay may need.
   * Idempotent: a sha that already has a ref for this Thread is not pinned again. Returns the ref name, or
   * null when the commit is not in the bare repo (nothing to pin).
   */
  async pinEvalRef(repo: string, issueNumber: number, sha: string): Promise<string | null> {
    if (!REPO_SLUG_RE.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`pinEvalRef: bad repo or sha (${repo}, ${sha})`);
    const has = await this.runGit(this.bareRepoPath, ["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);
    if (!has) return null;
    const prefix = `refs/archangel/eval/${repo}/${issueNumber}/`;
    const existing = (await this.runGit(this.bareRepoPath, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]))
      .split("\n")
      .map((l) => l.trim().split(" "))
      .filter((p) => p.length === 2);
    const found = existing.find(([, oid]) => oid === sha);
    if (found) return found[0]!;
    const next = existing.reduce((m, [name]) => Math.max(m, Number(name!.slice(prefix.length)) || 0), 0) + 1;
    const ref = `${prefix}${next}`;
    await this.runGit(this.bareRepoPath, ["update-ref", ref, sha]);
    return ref;
  }

  async resolveRef(ref: string): Promise<string> {
    return (await this.runGit(this.bareRepoPath, ["rev-parse", ref])).trim();
  }

  /**
   * Creates an isolated throwaway clone for the implementer with no remote credentials.
   * Fetches the issue's staging ref if `startRef` is an unpushed staging SHA (fixes Opus H4).
   */
  async createThrowawayClone(issueNumber: number, startRef: string): Promise<string> {
    fs.mkdirSync(this.clonesDir, { recursive: true });
    const cloneDir = path.join(this.clonesDir, `issue-${issueNumber}-${Date.now()}`);
    await this.runGit(this.clonesDir, ["clone", "--no-local", this.bareRepoPath, cloneDir]);
    // Ensure unpushed staging refs (`refs/archangel/staging/<n>`) are reachable before checkout.
    const hasStart = await this.runGit(cloneDir, ["cat-file", "-e", `${startRef}^{commit}`])
      .then(() => true)
      .catch(() => false);
    if (!hasStart) {
      await this.runGit(cloneDir, [
        "fetch",
        this.bareRepoPath,
        `refs/archangel/staging/${issueNumber}`,
      ]).catch(async () => {
        await this.runGit(cloneDir, ["fetch", this.bareRepoPath, startRef]);
      });
    }
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
    // A ref the repo does not have is an error (ls-tree fails), never "file missing": callers halt on null.
    const listed = await this.runGit(this.bareRepoPath, ["ls-tree", "--name-only", ref, "--", relPath]);
    if (listed.trim() === "") return null;
    return this.runGit(this.bareRepoPath, ["show", `${ref}:${relPath}`]);
  }

  /** True when `sha` names a commit in the bare repo. */
  async hasCommit(sha: string): Promise<boolean> {
    return this.runGit(this.bareRepoPath, ["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);
  }


  /**
   * Lists tracked file paths under `dirPath` directly from the broker's bare repo at `ref`.
   */
  async listFilesAtRef(ref: string, dirPath: string): Promise<string[]> {
    try {
      const out = await this.runGit(this.bareRepoPath, [
        "ls-tree",
        "-r",
        "--name-only",
        ref,
        "--",
        dirPath,
      ]);
      return out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Runs the repository's `.agents/setup` script inside a fresh throwaway clone,
   * reading the script bytes strictly from `mainSha` (never from a PR branch)
   * under a throwaway HOME and scrubbed environment with no credentials.
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
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-setup-home-"));
    try {
      const cleanEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
        HOME: fakeHome,
        TMPDIR: fakeHome,
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
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  /**
   * Executes the language-agnostic Archangel Gate strictly against `this.bareRepoPath`
   * (never against the implementer clone), diffing `baseSha..headSha` but reading `.agents/archangel.json` and
   * `.pre-commit-config.yaml` strictly from `policyRef` (the current main tip, the same policy the Reconciler uses).
   */
  async runLocalGate(
    baseSha: string,
    headSha: string,
    policyRef: string,
    workClass?: WorkClass,
  ): Promise<LocalGateReport> {
    return runGate({
      workClass,
      policyRef,
      repoDir: this.bareRepoPath,
      baseRef: baseSha,
      headRef: headSha,
      skipTests: this.localGateSkipTests,
      baseRunsOverride: 1,
      headRunsOverride: 1,
      commandTimeoutMs: this.localGateTimeoutMs,
    });
  }

  /**
   * Hardened fetch from an untrusted throwaway clone into the broker's bare repo,
   * followed by NUL-delimited (-z) protected-path, diff-bound, and optional local Gate verification.
   */
  async fetchAndValidateFromClone(
    cloneDir: string,
    issueNumber: number,
    baseSha: string,
    /** The repo's resolved Gate policy. Required: there is no host-side default, so no caller can validate against an empty policy. */
    bounds: GatePolicy,
    workClass?: WorkClass,
  ): Promise<BrokerFetchValidation> {
    const { maxNonTestLines, maxTotalLines, maxFiles, extraProtectedPaths, testFileGlobs, testDataGlobs } = bounds;

    // If a sandboxed agent (e.g. `codex --sandbox workspace-write` where `.git` is read-only)
    // left clean working-tree edits uncommitted, stage and commit them safely with hooks disabled.
    const dirty = (await this.runGit(cloneDir, ["status", "--porcelain"])).trim();
    if (dirty.length > 0) {
      await this.runGit(cloneDir, ["add", "-A"]);
      await this.runGit(cloneDir, [
        "commit",
        "--no-verify",
        "-m",
        `fix(#${issueNumber}): archangel factory attempt`,
      ]);
    }

    const stagingRef = `refs/archangel/staging/${issueNumber}`;
    await this.runGit(this.bareRepoPath, ["fetch", cloneDir, `+HEAD:${stagingRef}`]);
    const headSha = await this.resolveRef(stagingRef);

    // Compare against merge-base(baseSha, headSha) so unrelated commits that landed on `main`
    // while a PR branch was in flight never masquerade as agent edits to protected files!
    const effectiveBase =
      (
        await this.runGit(this.bareRepoPath, ["merge-base", baseSha, headSha]).catch(() => baseSha)
      ).trim() || baseSha;

    // Use Gate's NUL-delimited `-z` diff parser so non-ASCII/quoted paths cannot dodge protection (Opus S1).
    const stats = await getDiffStats(this.bareRepoPath, effectiveBase, headSha, {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: os.tmpdir(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    const changedFiles: string[] = [];
    const protectedViolations: string[] = [];
    let nonTestLines = 0;
    let totalLines = 0;

    for (const st of stats) {
      changedFiles.push(st.path);
      if (isProtectedPath(st.path, extraProtectedPaths)) {
        protectedViolations.push(`protected path modified: ${st.path}`);
      }
      if (st.binary) {
        protectedViolations.push(`binary file modified: ${st.path}`);
        continue;
      }
      const lines = st.added + st.deleted;
      totalLines += lines;
      if (!isTestOrFixtureFile(st.path, { testFileGlobs, testDataGlobs })) {
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
      effectiveBase,
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
      gateReport = await this.runLocalGate(effectiveBase, headSha, baseSha, workClass);
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
      "--force",
      remoteUrl,
      `${headSha}:refs/heads/${branchName}`,
    ]);
    await this.runGit(this.bareRepoPath, ["update-ref", `refs/heads/${branchName}`, headSha]);
  }

  /**
   * Reads unified diff and full touched file contents directly from the broker's bare repo.
   */
  async getDiffAndTouchedFiles(
    baseSha: string,
    headSha: string,
  ): Promise<{ diffText: string; touchedFiles: Record<string, string> }> {
    const effectiveBase =
      (
        await this.runGit(this.bareRepoPath, ["merge-base", baseSha, headSha]).catch(() => baseSha)
      ).trim() || baseSha;
    const diffText = await this.runGit(this.bareRepoPath, [
      "diff",
      "--no-color",
      effectiveBase,
      headSha,
    ]);
    const filesRaw = await this.runGit(this.bareRepoPath, [
      "diff",
      "--name-only",
      "--no-renames",
      effectiveBase,
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
   * Deterministically rebases `headSha` onto `mainSha` inside an isolated Broker clone
   * (0 LLM tokens, hooks disabled). Returns `{ ok: false }` on any conflict so caller can fall back.
   */
  async rebaseCleanOntoMain(
    issueNumber: number,
    mainSha: string,
    headSha: string,
  ): Promise<{ ok: true; headSha: string } | { ok: false; error: string }> {
    const branchName = `factory/${issueNumber}`;
    const tmpDir = path.join(this.clonesDir, `rebase-${issueNumber}-${Date.now()}`);
    fs.mkdirSync(this.clonesDir, { recursive: true });
    try {
      await this.runGit(this.clonesDir, ["clone", "--no-local", this.bareRepoPath, tmpDir]);
      // Ensure both commits are reachable inside the temp clone.
      const hasHead = await this.runGit(tmpDir, ["cat-file", "-e", `${headSha}^{commit}`])
        .then(() => true)
        .catch(() => false);
      if (!hasHead) {
        await this.runGit(tmpDir, ["fetch", this.bareRepoPath, headSha]);
      }
      await this.runGit(tmpDir, ["checkout", "-B", branchName, headSha]);
      await this.runGit(tmpDir, ["config", "user.name", "Archangel Worker"]);
      await this.runGit(tmpDir, ["config", "user.email", "archangel-worker@users.noreply.github.com"]);
      const oldBase = (await this.runGit(tmpDir, ["merge-base", mainSha, headSha])).trim();
      await this.runGit(tmpDir, ["rebase", "--onto", mainSha, oldBase]);
      const stagingRef = `refs/archangel/staging/${issueNumber}`;
      await this.runGit(this.bareRepoPath, ["fetch", tmpDir, `+HEAD:${stagingRef}`]);
      const rebasedSha = await this.resolveRef(stagingRef);
      return { ok: true, headSha: rebasedSha };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.removeClone(tmpDir);
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
