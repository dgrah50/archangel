import type { CollectedResult, ExecResult, ExecSpec } from "../compute/provider.js";
import type { WorkClass } from "../core/work-class.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { execFileGroup } from "../core/spawn-group.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_SLUG_RE, type GatePolicy } from "../config.js";
import { emit } from "../core/telemetry.js";
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

export const HARDENED_GIT_FLAGS = [
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

/** A remote provider's result bundle larger than this is refused before it is fetched. */
export const MAX_RESULT_BUNDLE_BYTES = 50 * 1024 * 1024;

const FACTORY_BRANCH_RE = /^factory\/(?:revert-|feature-|chore-)?\d+$/;
/** Machine-drafted owner-review PRs (correction loop): never `factory/*`, so the daemon's own Lander can never merge them. */
const AGENT_DRAFT_BRANCH_RE = /^agent-draft\/[a-z0-9-]{1,60}-\d+$/;

function exitedOne(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 1;
}

/** `git merge-tree --write-tree` exits 1 with a tree OID on stdout on conflicts; exit 1 with empty stdout (e.g. missing commit) or any other code is an error. */
function isMergeTreeConflict(err: unknown): boolean {
  if (!exitedOne(err)) return false;
  const stdout = (err as { stdout?: unknown }).stdout;
  return typeof stdout === "string" && /^[0-9a-f]{40,64}(?:\r?\n|$)/.test(stdout);
}

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
  /** `owner/name`, only to attribute telemetry. */
  repo?: string;
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
  private readonly repo: string | null;

  constructor(opts: GitBrokerOptions) {
    this.bareRepoPath = path.resolve(opts.bareRepoPath);
    this.clonesDir = path.resolve(opts.clonesDir);
    this.defaultBranch = opts.defaultBranch ?? "main";
    this.enableLocalGate = opts.enableLocalGate ?? false;
    this.localGateSkipTests = opts.localGateSkipTests ?? false;
    this.localGateTimeoutMs = opts.localGateTimeoutMs ?? 180_000;
    this.repo = opts.repo ?? null;
  }

  private gitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    };
  }

  private async runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFileAsync("git", [...HARDENED_GIT_FLAGS, ...args], {
      cwd,
      env: this.gitEnv(env),
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  }

  private async runGitBytes(cwd: string, args: string[]): Promise<Buffer> {
    const { stdout } = await execFileAsync("git", [...HARDENED_GIT_FLAGS, ...args], {
      cwd,
      env: this.gitEnv(),
      maxBuffer: 20 * 1024 * 1024,
      encoding: "buffer",
    });
    return stdout;
  }

  async ensureBareRepo(remoteUrl: string): Promise<void> {
    fs.mkdirSync(path.dirname(this.bareRepoPath), { recursive: true });
    if (!fs.existsSync(this.bareRepoPath)) {
      const t0 = Date.now();
      await this.runGit(path.dirname(this.bareRepoPath), [
        "clone",
        "--bare",
        remoteUrl,
        this.bareRepoPath,
      ]);
      emit("broker_ms", Date.now() - t0, { op: "clone" }, this.repo);
      // Never retain embedded token URLs inside bare repo config.
      await this.runGit(this.bareRepoPath, ["remote", "remove", "origin"]);
      return;
    }
    await this.syncFromRemote(remoteUrl);
  }

  async syncFromRemote(remoteUrl: string): Promise<void> {
    const t0 = Date.now();
    await this.runGit(this.bareRepoPath, [
      "fetch",
      "--prune",
      remoteUrl,
      `+refs/heads/${this.defaultBranch}:refs/heads/${this.defaultBranch}`,
      "+refs/heads/factory/*:refs/heads/factory/*",
    ]);
    emit("broker_ms", Date.now() - t0, { op: "fetch" }, this.repo);
  }

  /**
   * Keeps `sha` alive under `refs/archangel/eval/<repo>/<issue>/<n>` in the bare repo, so pruning a merged
   * `factory/*` branch on GitHub (the fetch above uses --prune) never loses a commit replay may need.
   * Idempotent: a sha that already has a ref for this Thread is not pinned again. Returns the ref name, or
   * null when the commit is not in the bare repo (nothing to pin).
   */
  async pinEvalRef(repo: string, issueNumber: number, sha: string): Promise<string | null> {
    if (!REPO_SLUG_RE.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`pinEvalRef: bad repo or sha (${repo}, ${sha})`);
    if (!(await this.hasCommit(sha))) return null;
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

  /** Keeps a PoC commit as a local ref in the bare repo. The ref name is built here from an integer; there is no push path. */
  async savePocRef(issueNumber: number, headSha: string): Promise<string> {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !/^[0-9a-f]{40}$/.test(headSha)) throw new Error(`savePocRef: bad issue or sha (${issueNumber}, ${headSha})`);
    const ref = `refs/pitch-poc/${issueNumber}`;
    await this.runGit(this.bareRepoPath, ["update-ref", ref, headSha]);
    return ref;
  }

  /** `git diff --stat` between two commits in the bare repo. */
  async diffStat(baseSha: string, headSha: string): Promise<string> {
    return (await this.runGit(this.bareRepoPath, ["diff", "--stat", "--no-color", baseSha, headSha])).trim();
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
    const t0 = Date.now();
    await this.runGit(this.clonesDir, ["clone", "--no-local", this.bareRepoPath, cloneDir]);
    emit("broker_ms", Date.now() - t0, { op: "clone" }, this.repo);
    // Ensure unpushed staging refs (`refs/archangel/staging/<n>`) are reachable before checkout.
    const hasStart = await this.hasCommitIn(cloneDir, startRef);
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

  /** A bundle holding `startSha` and its history (and `baseSha`, the default branch tip, when given), for a remote provider to start from; the box never needs a Git credential. */
  async createStartBundle(issueNumber: number, startSha: string, baseSha?: string): Promise<string> {
    fs.mkdirSync(this.clonesDir, { recursive: true });
    const file = path.join(this.clonesDir, `start-${issueNumber}-${Date.now()}.bundle`);
    const ref = `refs/archangel/start/${issueNumber}`;
    const baseRef = `refs/archangel/base/${issueNumber}`;
    await this.runGit(this.bareRepoPath, ["update-ref", ref, startSha]);
    if (baseSha) await this.runGit(this.bareRepoPath, ["update-ref", baseRef, baseSha]);
    try {
      await this.runGit(this.bareRepoPath, ["bundle", "create", file, ref, ...(baseSha ? [baseRef] : [])]);
    } finally {
      await this.runGit(this.bareRepoPath, ["update-ref", "-d", ref]);
      if (baseSha) await this.runGit(this.bareRepoPath, ["update-ref", "-d", baseRef]);
    }
    return file;
  }

  /** Refuses a result bundle over the size cap or one `git bundle verify` rejects (against this repo, so its prerequisites must exist here). */
  async verifyBundle(bundlePath: string): Promise<void> {
    const size = fs.statSync(bundlePath).size;
    if (size > MAX_RESULT_BUNDLE_BYTES) throw new Error(`result bundle is ${size} bytes, over the ${MAX_RESULT_BUNDLE_BYTES} byte cap`);
    await this.runGit(this.bareRepoPath, ["bundle", "verify", bundlePath]);
  }

  /**
   * `fetchAndValidateFromClone` for whatever a provider collected. A bundle is unpacked into a scratch clone with the same
   * hardened flags (fsck on fetch), then validated exactly like a clone; the scratch clone is always removed.
   */
  async fetchAndValidateCollected(
    collected: CollectedResult,
    issueNumber: number,
    baseSha: string,
    bounds: GatePolicy,
    workClass?: WorkClass,
  ): Promise<BrokerFetchValidation> {
    if (collected.kind === "clone") return this.fetchAndValidateFromClone(collected.path, issueNumber, baseSha, bounds, workClass);
    if (collected.kind === "bundle") await this.verifyBundle(collected.path);
    const scratch = path.join(this.clonesDir, `bundle-${issueNumber}-${Date.now()}`);
    try {
      await this.runGit(this.clonesDir, ["clone", "--no-local", this.bareRepoPath, scratch]);
      if (collected.kind === "empty") {
        await this.runGit(scratch, ["checkout", "-B", `factory/${issueNumber}`, collected.startSha]);
      } else {
        await this.runGit(scratch, ["fetch", collected.path, "+HEAD:refs/archangel/result"]);
        await this.runGit(scratch, ["checkout", "-B", `factory/${issueNumber}`, "refs/archangel/result"]);
      }
      await this.runGit(scratch, ["remote", "remove", "origin"]);
      return await this.fetchAndValidateFromClone(scratch, issueNumber, baseSha, bounds, workClass);
    } finally {
      this.removeClone(scratch);
    }
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

  /**
   * The commit on `ref` (first-parent) that introduced the version of `relPath` whose sha256 is `sha256`: the oldest commit of
   * the unbroken run that holds those bytes. Null when no recent version matches. Looks back at most `max` commits.
   */
  async commitIntroducingBlob(ref: string, relPath: string, sha256: string, max = 50): Promise<string | null> {
    const log = await this.runGit(this.bareRepoPath, ["log", "--first-parent", `--max-count=${max}`, "--format=%H", ref, "--", relPath]);
    let found: string | null = null;
    for (const sha of log.split("\n").filter(Boolean)) {
      const text = await this.readFileAtRef(sha, relPath);
      const match = text !== null && createHash("sha256").update(text).digest("hex") === sha256;
      if (match) found = sha;
      else if (found !== null) break;
    }
    return found;
  }

  /** Binary-safe `readFileAtRef`: the exact bytes of a blob, or null when the path does not exist at that ref. */
  async readBinaryAtRef(ref: string, relPath: string): Promise<Buffer | null> {
    const listed = await this.runGit(this.bareRepoPath, ["ls-tree", "--name-only", ref, "--", relPath]);
    if (listed.trim() === "") return null;
    return this.runGitBytes(this.bareRepoPath, ["show", `${ref}:${relPath}`]);
  }

  private async hasCommitIn(repoDir: string, ref: string): Promise<boolean> {
    try {
      await this.runGit(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return true;
    } catch (err) {
      if (exitedOne(err)) return false;
      throw err;
    }
  }

  private async resolveEffectiveBase(baseSha: string, headSha: string): Promise<string> {
    const mergeBase = (await this.runGit(this.bareRepoPath, ["merge-base", baseSha, headSha])).trim();
    if (!mergeBase) {
      throw new Error(`git merge-base returned empty output for ${baseSha}..${headSha}`);
    }
    return mergeBase;
  }

  /** True when `sha` names a commit in the bare repo. */
  async hasCommit(sha: string): Promise<boolean> {
    return this.hasCommitIn(this.bareRepoPath, sha);
  }


  /**
   * Lists tracked file paths under `dirPath` directly from the broker's bare repo at `ref`.
   */
  async listFilesAtRef(ref: string, dirPath: string): Promise<string[]> {
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
  }

  /**
   * Commits reachable from `ref` over the last `sinceDays`, newest first, as SHA plus changed paths only (no subjects,
   * bodies or diffs: those are free text). Capped at `max` commits.
   */
  async listRecentCommits(ref: string, sinceDays: number, max: number): Promise<Array<{ sha: string; paths: string[] }>> {
    const out = await this.runGit(this.bareRepoPath, [
      "log",
      "--first-parent",
      "--name-only",
      "--no-renames",
      `--since=${Math.floor(sinceDays)}.days.ago`,
      `--max-count=${Math.floor(max)}`,
      "--format=@@%H",
      ref,
    ]);
    const commits: Array<{ sha: string; paths: string[] }> = [];
    for (const line of out.split("\n")) {
      if (line.startsWith("@@")) commits.push({ sha: line.slice(2), paths: [] });
      else if (line.trim() && commits.length > 0) commits[commits.length - 1]!.paths.push(line.trim());
    }
    return commits;
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
    /** Runs the script on a remote workspace instead of in `cloneDir` on this machine. */
    remote?: (spec: ExecSpec) => Promise<ExecResult>,
  ): Promise<{ ran: boolean; stdout: string }> {
    const script = await this.readFileAtRef(mainSha, ".agents/setup");
    if (!script || !script.trim()) {
      return { ran: false, stdout: "" };
    }
    if (remote) {
      const res = await remote({
        cmd: "/bin/sh",
        args: ["-eu", "-c", script],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
        timeoutMs,
      });
      if (res.code !== 0) throw new Error(`repo setup exited ${res.code}: ${(res.stderr || res.stdout).trim().slice(-300)}`);
      return { ran: true, stdout: res.stdout };
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
      const { stdout } = await execFileGroup("/bin/sh", ["-eu", "-c", script], {
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
    const t0 = Date.now();
    let report: LocalGateReport | undefined;
    try {
      report = await runGate({
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
      return report;
    } finally {
      const ms = Date.now() - t0;
      // The Gate does not report a timeout as such: a failed run that lasted at least the command timeout hit it.
      const outcome = !report ? "error" : report.passed ? "passed" : ms >= this.localGateTimeoutMs ? "timeout" : "failed";
      emit("gate_ms", ms, { outcome }, this.repo);
    }
  }

  /**
   * Fetches an untrusted clone's HEAD into the bare repo under `stagingRef` and returns its sha. If a sandboxed agent (e.g.
   * `codex --sandbox workspace-write` where `.git` is read-only) left clean working-tree edits uncommitted, they are staged
   * and committed first with hooks disabled.
   */
  async stageCloneHead(cloneDir: string, stagingRef: string, commitMessage: string): Promise<string> {
    const dirty = (await this.runGit(cloneDir, ["status", "--porcelain"])).trim();
    if (dirty.length > 0) {
      await this.runGit(cloneDir, ["add", "-A"]);
      await this.runGit(cloneDir, ["commit", "--no-verify", "-m", commitMessage]);
    }
    await this.runGit(this.bareRepoPath, ["fetch", cloneDir, `+HEAD:${stagingRef}`]);
    return this.resolveRef(stagingRef);
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

    const stagingRef = `refs/archangel/staging/${issueNumber}`;
    const headSha = await this.stageCloneHead(cloneDir, stagingRef, `fix(#${issueNumber}): archangel factory attempt`);

    // Compare against merge-base(baseSha, headSha) so unrelated commits that landed on `main`
    // while a PR branch was in flight never masquerade as agent edits to protected files!
    const effectiveBase = await this.resolveEffectiveBase(baseSha, headSha);

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
    for (const st of stats.slice(0, 10)) {
      if (st.status === "D") continue;
      touchedFiles[st.path] = await this.runGit(this.bareRepoPath, [
        "show",
        `${headSha}:${st.path}`,
      ]);
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
   * Pushes a validated commit strictly to `factory/<issue>`, `factory/feature-<issue>`, `factory/chore-<issue>` or `factory/revert-<issue>`.
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
   * Commits one file's new content on top of `baseSha` and pushes it strictly to `agent-draft/<slug>-<n>`. Plumbing only: nothing is
   * checked out, and the commit exists only in the broker's bare repo until pushed. Returns the commit sha.
   */
  async pushDraftBranch(branchName: string, baseSha: string, file: string, content: string, message: string, remoteUrl: string): Promise<string> {
    if (!AGENT_DRAFT_BRANCH_RE.test(branchName)) throw new Error(`Broker refused push to non-draft branch: ${branchName}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-draft-blob-"));
    try {
      const blobFile = path.join(tmp, "blob");
      fs.writeFileSync(blobFile, content);
      const blob = (await this.runGit(this.bareRepoPath, ["hash-object", "-w", blobFile])).trim();
      const env = { GIT_INDEX_FILE: path.join(tmp, "index"), GIT_AUTHOR_NAME: "Archangel", GIT_AUTHOR_EMAIL: "archangel@users.noreply.github.com", GIT_COMMITTER_NAME: "Archangel", GIT_COMMITTER_EMAIL: "archangel@users.noreply.github.com" };
      await this.runGit(this.bareRepoPath, ["read-tree", baseSha], env);
      await this.runGit(this.bareRepoPath, ["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], env);
      const tree = (await this.runGit(this.bareRepoPath, ["write-tree"], env)).trim();
      const sha = (await this.runGit(this.bareRepoPath, ["commit-tree", tree, "-p", baseSha, "-m", message], env)).trim();
      await this.runGit(this.bareRepoPath, ["push", "--force", remoteUrl, `${sha}:refs/heads/${branchName}`]);
      await this.runGit(this.bareRepoPath, ["update-ref", `refs/heads/${branchName}`, sha]);
      return sha;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  /**
   * Reads unified diff and full touched file contents directly from the broker's bare repo.
   */
  async getDiffAndTouchedFiles(
    baseSha: string,
    headSha: string,
  ): Promise<{ diffText: string; touchedFiles: Record<string, string> }> {
    const effectiveBase = await this.resolveEffectiveBase(baseSha, headSha);
    const diffText = await this.runGit(this.bareRepoPath, [
      "diff",
      "--no-color",
      effectiveBase,
      headSha,
    ]);
    const statusRaw = await this.runGit(this.bareRepoPath, [
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      effectiveBase,
      headSha,
    ]);
    const tokens = statusRaw.split("\0");
    const touchedFiles: Record<string, string> = {};
    let seen = 0;
    for (let i = 0; i + 1 < tokens.length && seen < 10; i += 2) {
      const status = tokens[i];
      const filePath = tokens[i + 1];
      if (!status || !filePath) continue;
      seen++;
      if (status === "D") continue;
      touchedFiles[filePath] = await this.runGit(this.bareRepoPath, [
        "show",
        `${headSha}:${filePath}`,
      ]);
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
    } catch (err) {
      if (isMergeTreeConflict(err)) return false;
      throw err;
    }
  }

  /** True when merging `headSha` into `mainSha` changes nothing: the branch's change is already on main. A conflicting merge is false. */
  async isAlreadyOnMain(mainSha: string, headSha: string): Promise<boolean> {
    try {
      const tree = (await this.runGit(this.bareRepoPath, ["merge-tree", "--write-tree", mainSha, headSha])).trim();
      return tree === (await this.runGit(this.bareRepoPath, ["rev-parse", `${mainSha}^{tree}`])).trim();
    } catch (err) {
      if (isMergeTreeConflict(err)) return false;
      throw err;
    }
  }

  /**
   * Deterministically rebases `headSha` onto `mainSha` inside an isolated Broker clone
   * (0 LLM tokens, hooks disabled). Returns `{ ok: false }` on rebase conflict so caller can fall back.
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
      const hasHead = await this.hasCommitIn(tmpDir, headSha);
      if (!hasHead) {
        await this.runGit(tmpDir, ["fetch", this.bareRepoPath, headSha]);
      }
      await this.runGit(tmpDir, ["checkout", "-B", branchName, headSha]);
      await this.runGit(tmpDir, ["config", "user.name", "Archangel Worker"]);
      await this.runGit(tmpDir, ["config", "user.email", "archangel-worker@users.noreply.github.com"]);
      const oldBase = (await this.runGit(tmpDir, ["merge-base", mainSha, headSha])).trim();
      try {
        await this.runGit(tmpDir, ["rebase", "--onto", mainSha, oldBase]);
      } catch (err) {
        if (exitedOne(err)) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        throw err;
      }
      const stagingRef = `refs/archangel/staging/${issueNumber}`;
      await this.runGit(this.bareRepoPath, ["fetch", tmpDir, `+HEAD:${stagingRef}`]);
      const rebasedSha = await this.resolveRef(stagingRef);
      return { ok: true, headSha: rebasedSha };
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
