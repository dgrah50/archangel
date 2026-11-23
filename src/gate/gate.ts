import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { execFileGroup } from "../core/spawn-group.js";
import { GatePolicySchema, REPO_POLICY_PATH, type GatePolicy } from "../config.js";
import type { WorkClass } from "../core/work-class.js";
import { attributableTo, capIds, clearReports, readReports } from "./junit.js";
import { UNIVERSAL_PROTECTED_EXACT, UNIVERSAL_PROTECTED_PREFIXES, Workflow, toGatePolicy } from "../core/workflow.js";

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

const SUPPORTED_LOCAL_HOOK_KEYS = new Set([
  "id",
  "name",
  "entry",
  "language",
  "files",
  "exclude",
  "pass_filenames",
  "always_run",
  "stages",
  "description",
]);

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  re += "$";
  return new RegExp(re);
}

export function matchesAnyGlob(relPath: string, globs: string[]): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((g) => globToRegExp(g).test(normalized));
}

export function isProtectedPath(relPath: string, extraProtectedPaths: string[] = []): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = normalized.toLowerCase();
  const base = path.posix.basename(lower);
  if (UNIVERSAL_PROTECTED_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (UNIVERSAL_PROTECTED_EXACT.has(lower) || UNIVERSAL_PROTECTED_EXACT.has(base)) return true;
  if (base.startsWith("license") || base.startsWith("copying")) return true;
  if (lower.includes("/.git/") || lower === ".git") return true;

  for (const raw of extraProtectedPaths) {
    const pat = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!pat) continue;
    const effective = pat.endsWith("/") ? `${pat}**` : pat;
    if (globToRegExp(effective.toLowerCase()).test(lower)) return true;
  }
  return false;
}

export function isTestFile(relPath: string, policy: Pick<GatePolicy, "testFileGlobs">): boolean {
  return policy.testFileGlobs.length > 0 && matchesAnyGlob(relPath, policy.testFileGlobs);
}

export function isTestDataFile(relPath: string, policy: Pick<GatePolicy, "testDataGlobs">): boolean {
  return policy.testDataGlobs.length > 0 && matchesAnyGlob(relPath, policy.testDataGlobs);
}

export function isTestOrFixtureFile(
  relPath: string,
  policy: Pick<GatePolicy, "testFileGlobs" | "testDataGlobs">,
): boolean {
  return isTestFile(relPath, policy) || isTestDataFile(relPath, policy);
}

export interface GateFileStat {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  status: string;
}

export interface GateReport {
  passed: boolean;
  base_sha: string;
  head_sha: string;
  revert_exempt: boolean;
  already_fixed: boolean;
  new_test_files: string[];
  hooks_run: string[];
  violations: string[];
  file_stats: GateFileStat[];
  /** Trimmed reproduction-test output (machine output, for the Recap). Absent if the run never got that far. */
  proof?: GateProof;
}

export interface GateProof {
  base_output?: string;
  head_output?: string;
  /** Test IDs matched in the JUnit report (only when `gate.junitReport` is set). */
  junit?: { base_failed: string[]; head_passed: string[] };
}

export const GATE_PROOF_ANNOTATION_TITLE = "archangel-gate-proof";
export const PROOF_MAX_LINES = 40;
export const PROOF_MAX_CHARS = 3000;
/** GitHub truncates a check-run annotation message at 4,096 characters; a truncated proof is invalid JSON and reads as no proof. */
export const PROOF_MESSAGE_MAX_BYTES = 3900;

/**
 * Runs the Gate for GitHub Actions with workflow commands disabled while any repo-authored code
 * (setup, build, tests, hooks) runs, so nothing it prints can forge an annotation. Commands are
 * resumed with a random token only after every repo command has finished, then the proof is emitted.
 */
export async function runGateForActions(
  opts: GateRunOptions,
  log: (line: string) => void,
  run: (o: GateRunOptions) => Promise<GateReport> = runGate,
  token: string = crypto.randomBytes(16).toString("hex"),
  /**
   * The PR head commit the proof belongs to. In Actions the Gate runs on the pull_request MERGE commit, whose SHA is not the check
   * run's head SHA, and the daemon accepts a proof only for the exact head it is looking at. No valid SHA means no proof is
   * emitted: a missing proof is shown as missing, a proof for the wrong commit would be worse.
   */
  proofHeadSha?: string,
): Promise<GateReport> {
  log(`::stop-commands::${token}`);
  let report: GateReport;
  try {
    report = await run(opts);
    log(JSON.stringify(report, null, 2));
  } finally {
    log(`::${token}::`);
  }
  if (proofHeadSha !== undefined && /^[0-9a-f]{40}$/.test(proofHeadSha)) {
    const message = fitProofMessage(proofHeadSha, report.proof)
      .replace(/%/g, "%25")
      .replace(/\r/g, "%0D")
      .replace(/\n/g, "%0A");
    log(`::notice title=${GATE_PROOF_ANNOTATION_TITLE}::${message}`);
  }
  return report;
}

/** The proof JSON, with its output tails shortened (keeping the end) until it fits one annotation message. */
export function fitProofMessage(headSha: string, proof: GateProof | undefined): string {
  const p: GateProof = { ...proof };
  for (;;) {
    const message = JSON.stringify({ head_sha: headSha, ...p });
    if (Buffer.byteLength(message) <= PROOF_MESSAGE_MAX_BYTES) return message;
    const key = (p.head_output?.length ?? 0) >= (p.base_output?.length ?? 0) ? "head_output" : "base_output";
    const cur = p[key];
    if (!cur) return JSON.stringify({ head_sha: headSha });
    p[key] = cur.slice(-Math.floor(cur.length * 0.8));
  }
}

/** Last ~40 lines, capped at 3,000 chars (keeping the end, where failures and summaries are). */
export function tailOutput(text: string): string {
  const tail = text.trim().split("\n").slice(-PROOF_MAX_LINES).join("\n");
  return tail.length > PROOF_MAX_CHARS ? tail.slice(-PROOF_MAX_CHARS) : tail;
}

export interface GateRunOptions {
  repoDir: string;
  baseRef: string;
  headRef: string;
  revertOf?: string;
  baseRunsOverride?: number;
  headRunsOverride?: number;
  skipPreCommit?: boolean;
  skipTests?: boolean;
  commandTimeoutMs?: number;
  /** `feature` and `chore` skip the red-on-base and new-test-file requirements only. Defaults to `bugfix` (full reproduction proof). */
  workClass?: WorkClass;
  /**
   * Commit to read `.agents/archangel.json` and the pre-commit config from (default: `baseRef`). The daemon passes the current main tip
   * so a pre-push check of an in-flight branch judges the same policy as the Reconciler instead of the (older) merge-base's.
   */
  policyRef?: string;
}

interface PreCommitHook {
  id: string;
  name?: string;
  entry: string;
  language?: string;
  files?: string;
  exclude?: string;
  pass_filenames?: boolean;
  always_run?: boolean;
  stages?: string[];
  [key: string]: unknown;
}

interface PreCommitRepo {
  repo: string;
  rev?: string;
  hooks?: PreCommitHook[];
}

interface PreCommitConfig {
  repos?: PreCommitRepo[];
  files?: string;
  exclude?: string;
  [key: string]: unknown;
}

function makeIsolatedEnv(runTempDir: string): NodeJS.ProcessEnv {
  const fakeHome = path.join(runTempDir, "home");
  const freshGoCache = path.join(runTempDir, "gocache");
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(freshGoCache, { recursive: true });

  const realHome = os.homedir();
  const defaultGoModCache = process.env.GOMODCACHE ?? path.join(realHome, "go", "pkg", "mod");
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    HOME: fakeHome,
    TMPDIR: runTempDir,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GOCACHE: freshGoCache,
    GOFLAGS: "-modcacherw",
    ...(fs.existsSync(defaultGoModCache) ? { GOMODCACHE: defaultGoModCache } : {}),
    ...(process.env.CI ? { CI: process.env.CI } : {}),
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH
      ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
      : {}),
  };
}

async function runGit(repoDir: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync("git", [...HARDENED_GIT_FLAGS, ...args], {
    cwd: repoDir,
    env,
    maxBuffer: 25 * 1024 * 1024,
  });
  return stdout;
}

async function readGitFileStrict(
  repoDir: string,
  ref: string,
  relPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  // Use ls-tree so a path absent from a valid tree returns null, while git/object errors throw (fail closed).
  const listed = await runGit(repoDir, ["ls-tree", "--name-only", ref, "--", relPath], env);
  if (listed.trim() === "") return null;
  return runGit(repoDir, ["show", `${ref}:${relPath}`], env);
}

async function readGitFileBuffer(
  repoDir: string,
  ref: string,
  relPath: string,
  env: NodeJS.ProcessEnv,
): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "git",
    [...HARDENED_GIT_FLAGS, "show", `${ref}:${relPath}`],
    {
      cwd: repoDir,
      env,
      encoding: "buffer",
      maxBuffer: 25 * 1024 * 1024,
    },
  );
  return stdout;
}

async function extractCommitTree(
  repoDir: string,
  sha: string,
  destDir: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  await execFileAsync(
    "/bin/sh",
    ["-eu", "-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "--", repoDir, sha, destDir],
    { env, maxBuffer: 25 * 1024 * 1024 },
  );
  // Share pre-installed node_modules from repoDir when present (e.g. CI npm ci after verifying lockfile untouched).
  const srcNodeModules = path.join(repoDir, "node_modules");
  const dstNodeModules = path.join(destDir, "node_modules");
  if (fs.existsSync(srcNodeModules) && !fs.existsSync(dstNodeModules)) {
    fs.symlinkSync(path.resolve(srcNodeModules), dstNodeModules, "dir");
  }
}

export async function getDiffStats(
  repoDir: string,
  baseSha: string,
  headSha: string,
  env: NodeJS.ProcessEnv,
): Promise<GateFileStat[]> {
  const [numstatRaw, statusRaw] = await Promise.all([
    runGit(repoDir, ["diff", "--numstat", "--no-renames", "-z", baseSha, headSha], env),
    runGit(repoDir, ["diff", "--name-status", "--no-renames", "-z", baseSha, headSha], env),
  ]);

  const statusMap = new Map<string, string>();
  const statusTokens = statusRaw.split("\0");
  for (let i = 0; i + 1 < statusTokens.length; i += 2) {
    const st = statusTokens[i];
    const file = statusTokens[i + 1];
    if (st && file) statusMap.set(file, st);
  }

  const stats: GateFileStat[] = [];
  for (const record of numstatRaw.split("\0")) {
    if (!record) continue;
    const parts = record.split("\t");
    if (parts.length < 3) continue;
    const [addStr, delStr, ...rest] = parts;
    const filePath = rest.join("\t");
    const binary = addStr === "-" || delStr === "-";
    stats.push({
      path: filePath,
      added: binary ? 0 : Number(addStr ?? 0),
      deleted: binary ? 0 : Number(delStr ?? 0),
      binary,
      status: statusMap.get(filePath) ?? "M",
    });
  }
  return stats;
}

async function runShellCmd(
  cwd: string,
  cmd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string; status: "passed" | "failed" | "timed_out" | "exec_error" }> {
  try {
    const { stdout, stderr } = await execFileGroup("/bin/sh", ["-eu", "-c", cmd], {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim(), status: "passed" };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number | string | null; killed?: boolean; signal?: string | null };
    const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || e.message || String(err);
    // Only a real non-zero exit is a failure. A timeout (killed by our timer) or a command that could not run at all
    // (spawn error, output buffer overflow) proves nothing about the code under test.
    const status = e.killed === true && e.signal ? "timed_out" : typeof e.code === "number" ? "failed" : "exec_error";
    return { ok: false, output: out, status };
  }
}

async function runLocalPreCommitHook(
  cwd: string,
  hook: PreCommitHook,
  files: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  const passFilenames = hook.pass_filenames !== false && files.length > 0;
  try {
    const cmd = passFilenames ? `${hook.entry} "$@"` : hook.entry;
    const args = passFilenames ? ["-eu", "-c", cmd, "--", ...files] : ["-eu", "-c", cmd];
    const { stdout, stderr } = await execFileGroup("/bin/sh", args, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || e.message || String(err);
    return { ok: false, output: out };
  }
}

function hashFileIfExists(fullPath: string): string | null {
  if (!fs.existsSync(fullPath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
}

function compilePreCommitRegex(
  pattern: unknown,
  label: string,
  violations: string[],
): { ok: true; re: RegExp | null } | { ok: false } {
  if (pattern === undefined || pattern === null || pattern === "") return { ok: true, re: null };
  if (typeof pattern !== "string") {
    violations.push(`invalid ${label} regex: expected string, got ${typeof pattern}`);
    return { ok: false };
  }
  try {
    return { ok: true, re: new RegExp(pattern) };
  } catch (err) {
    violations.push(
      `invalid ${label} regex '${pattern}': ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false };
  }
}

async function runRepoPreCommit(
  worktreeDir: string,
  configRaw: string,
  configFilename: string,
  changedFiles: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ hooksRun: string[]; violations: string[] }> {
  const hooksRun: string[] = [];
  const violations: string[] = [];

  let parsed: PreCommitConfig;
  try {
    parsed = (parseYaml(configRaw) ?? {}) as PreCommitConfig;
  } catch (err) {
    return {
      hooksRun,
      violations: [`invalid ${configFilename} on base: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const repos = Array.isArray(parsed.repos) ? parsed.repos : [];
  const remoteRepos = repos.filter((r) => r.repo !== "local" && r.repo !== "meta");
  const localRepos = repos.filter((r) => r.repo === "local");

  // Fail closed on top-level files/exclude filters if running natively without pre-commit CLI.
  const topIncludeRes = compilePreCommitRegex(parsed.files, `${configFilename} 'files'`, violations);
  const topExcludeRes = compilePreCommitRegex(parsed.exclude, `${configFilename} 'exclude'`, violations);
  if (!topIncludeRes.ok || !topExcludeRes.ok) {
    return { hooksRun, violations };
  }
  const topInclude = topIncludeRes.re;
  const topExclude = topExcludeRes.re;

  const beforeHashes = new Map<string, string | null>();
  for (const rel of changedFiles) {
    beforeHashes.set(rel, hashFileIfExists(path.join(worktreeDir, rel)));
  }

  for (const repo of localRepos) {
    for (const hook of repo.hooks ?? []) {
      const lang = hook.language ?? "system";
      if (lang !== "system") {
        violations.push(
          `pre-commit hook '${hook.id}' uses unsupported local language '${lang}' (only 'system' is supported natively; use pre-commit CLI or language: system)`,
        );
        continue;
      }
      const unsupportedKeys = Object.keys(hook).filter((k) => !SUPPORTED_LOCAL_HOOK_KEYS.has(k));
      if (unsupportedKeys.length > 0) {
        violations.push(
          `pre-commit hook '${hook.id}' uses unsupported key(s) [${unsupportedKeys.join(", ")}] — failing closed instead of silently ignoring`,
        );
        continue;
      }

      const stages = hook.stages ?? [];
      if (
        stages.length > 0 &&
        !stages.includes("pre-commit") &&
        !stages.includes("commit") &&
        !stages.includes("pre-merge-commit")
      ) {
        continue;
      }

      const includeRes = compilePreCommitRegex(hook.files, `pre-commit hook '${hook.id}' 'files'`, violations);
      const excludeRes = compilePreCommitRegex(hook.exclude, `pre-commit hook '${hook.id}' 'exclude'`, violations);
      if (!includeRes.ok || !excludeRes.ok) {
        continue;
      }
      const includeRe = includeRes.re;
      const excludeRe = excludeRes.re;
      const matched = changedFiles.filter((f) => {
        if (topInclude && !topInclude.test(f)) return false;
        if (topExclude && topExclude.test(f)) return false;
        if (includeRe && !includeRe.test(f)) return false;
        if (excludeRe && excludeRe.test(f)) return false;
        return true;
      });
      if (matched.length === 0 && !hook.always_run) continue;

      hooksRun.push(hook.id);
      const res = await runLocalPreCommitHook(worktreeDir, hook, matched, timeoutMs, env);
      if (!res.ok) {
        const snippet = res.output.split("\n").slice(0, 8).join(" | ");
        violations.push(`pre-commit hook '${hook.id}' failed: ${snippet}`);
      }
    }
  }

  if (remoteRepos.length > 0 && changedFiles.length > 0) {
    const remoteConfigPath = path.join(worktreeDir, ".archangel-remote-pre-commit.yaml");
    fs.writeFileSync(remoteConfigPath, JSON.stringify({ repos: remoteRepos }, null, 2), "utf8");
    try {
      await execFileAsync("git", ["init", "-q"], { cwd: worktreeDir, env });
      await execFileAsync("git", ["add", "-A"], { cwd: worktreeDir, env });
      await execFileGroup(
        "pre-commit",
        ["run", "--config", remoteConfigPath, "--files", ...changedFiles],
        { cwd: worktreeDir, env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      );
      for (const rr of remoteRepos) {
        for (const h of rr.hooks ?? []) hooksRun.push(h.id);
      }
    } catch (err: unknown) {
      const e = err as { code?: string | number; stdout?: string; stderr?: string; message?: string };
      if (e.code === "ENOENT") {
        violations.push(
          `${configFilename} declares remote hook repo(s) (${remoteRepos.map((r) => r.repo).join(", ")}) but 'pre-commit' CLI is not installed`,
        );
      } else {
        const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || e.message || String(err);
        violations.push(`pre-commit remote hooks failed: ${out.split("\n").slice(0, 8).join(" | ")}`);
      }
    } finally {
      fs.rmSync(remoteConfigPath, { force: true });
    }
  }

  for (const [rel, before] of beforeHashes.entries()) {
    const after = hashFileIfExists(path.join(worktreeDir, rel));
    if (after !== before) {
      violations.push(`pre-commit hook mutated file '${rel}' — PR must already satisfy hooks cleanly`);
    }
  }

  return { hooksRun, violations };
}

/**
 * Language-agnostic Archangel Mechanical Gate (ADR-0003 + Opus review hardening):
 * - Throwaway per-run HOME and fresh per-run GOCACHE (no shared cache poisoning / real HOME exposure).
 * - Always fail-closed on the base policy: requires strict `.agents/archangel.json`, non-empty `testFileGlobs`,
 *   non-empty `testCmd` (unless `skipTests`), and `.pre-commit-config.yaml` (unless `skipPreCommit`).
 * - Enforces diff bounds, protected paths, and pre-existing test-file AND test-fixture immutability.
 * - Executes repo-owned `.pre-commit-config.yaml` strictly from `base` (fail-closed on unsupported keys or file mutation).
 * - Verifies pristine `base` is green -> overlaid `base` compiles (`testBuildCmd`) and fails `testCmd` N× -> `HEAD` passes `testCmd` M×.
 */
export async function runGate(opts: GateRunOptions): Promise<GateReport> {
  const timeoutMs = opts.commandTimeoutMs ?? 5 * 60_000;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-gate-"));
  const env = makeIsolatedEnv(tmpRoot);

  try {
    const baseSha = (await runGit(opts.repoDir, ["rev-parse", `${opts.baseRef}^{commit}`], env)).trim();
    const headSha = (await runGit(opts.repoDir, ["rev-parse", `${opts.headRef}^{commit}`], env)).trim();

    const policySha = opts.policyRef
      ? (await runGit(opts.repoDir, ["rev-parse", `${opts.policyRef}^{commit}`], env)).trim()
      : baseSha;
    const stats = await getDiffStats(opts.repoDir, baseSha, headSha, env);
    const report: GateReport = {
      passed: false,
      base_sha: baseSha,
      head_sha: headSha,
      revert_exempt: false,
      already_fixed: false,
      new_test_files: [],
      hooks_run: [],
      violations: [],
      file_stats: stats,
    };

    const repoPolicyRaw = await readGitFileStrict(opts.repoDir, policySha, REPO_POLICY_PATH, env);
    if (!repoPolicyRaw) {
      report.violations.push("missing .agents/archangel.json on base commit (failing closed)");
      return report;
    }
    // Strict schema: a missing, unknown or out-of-kernel-bounds value fails closed; there is no other format.
    let json: unknown;
    try {
      json = JSON.parse(repoPolicyRaw);
    } catch (err) {
      report.violations.push(`.agents/archangel.json on base is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return report;
    }
    const parsed = Workflow.safeParse(json);
    if (!parsed.success) {
      report.violations.push(
        `.agents/archangel.json on base is not a valid workflow: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
      return report;
    }
    const policy = GatePolicySchema.parse(toGatePolicy(parsed.data.gate));
  

    for (const [name, v] of [["baseRunsOverride", opts.baseRunsOverride], ["headRunsOverride", opts.headRunsOverride]] as const) {
      if (v !== undefined && !(Number.isInteger(v) && v >= 1)) throw new Error(`${name} must be an integer >= 1 (got ${v})`);
    }
    const baseRuns = opts.baseRunsOverride ?? policy.baseTestRuns;
    const headRuns = opts.headRunsOverride ?? policy.headTestRuns;

    if (opts.revertOf) {
      const revertSha = (await runGit(opts.repoDir, ["rev-parse", `${opts.revertOf}^{commit}`], env)).trim();
      if (revertSha !== baseSha) {
        report.violations.push(
          `revert target ${revertSha} must match base tip ${baseSha} (cannot silently roll back later commits)`,
        );
        return report;
      }
      const parentTree = (await runGit(opts.repoDir, ["rev-parse", `${revertSha}^^{tree}`], env)).trim();
      const headTree = (await runGit(opts.repoDir, ["rev-parse", `${headSha}^{tree}`], env)).trim();
      if (parentTree !== headTree) {
        report.violations.push("revert PR tree does not match exact inverse of reverted commit");
        return report;
      }
      report.revert_exempt = true;
      if (!opts.skipTests && policy.testCmd) {
        const revDir = path.join(tmpRoot, "revert-head");
        await extractCommitTree(opts.repoDir, headSha, revDir, env);
        const res = await runShellCmd(revDir, policy.testCmd, timeoutMs, env);
        if (!res.ok) {
          report.violations.push(`revert testCmd failed: ${res.output.split("\n").slice(0, 6).join(" | ")}`);
          return report;
        }
      }
      report.passed = true;
      return report;
    }

    if (stats.length === 0) {
      report.violations.push("diff is empty");
      return report;
    }
    if (stats.length > policy.maxFiles) {
      report.violations.push(`changed files ${stats.length} exceeds limit ${policy.maxFiles}`);
    }

    let nonTestLines = 0;
    let totalLines = 0;
    const newTestFiles: string[] = [];
    const overlayFiles: string[] = [];

    for (const st of stats) {
      if (isProtectedPath(st.path, policy.extraProtectedPaths)) {
        report.violations.push(`protected path modified: ${st.path}`);
      }
      if (st.binary) {
        report.violations.push(`binary file modified: ${st.path}`);
      }
      const lines = st.added + st.deleted;
      totalLines += lines;
      if (!isTestOrFixtureFile(st.path, policy)) {
        nonTestLines += lines;
      }
      if (isTestFile(st.path, policy)) {
        if (st.status !== "A") {
          report.violations.push(
            `existing test file modified/deleted (${st.status}): ${st.path}; add new reproduction tests in a new test file`,
          );
        } else {
          newTestFiles.push(st.path);
          overlayFiles.push(st.path);
        }
      } else if (isTestDataFile(st.path, policy)) {
        if (st.status !== "A") {
          report.violations.push(
            `existing test fixture modified/deleted (${st.status}): ${st.path}; pre-existing fixtures are immutable`,
          );
        } else {
          overlayFiles.push(st.path);
        }
      }
    }

    report.new_test_files = newTestFiles;

    if (nonTestLines > policy.maxNonTestLines) {
      report.violations.push(`non-test changed lines ${nonTestLines} exceeds limit ${policy.maxNonTestLines}`);
    }
    if (totalLines > policy.maxTotalLines) {
      report.violations.push(`total changed lines ${totalLines} exceeds limit ${policy.maxTotalLines}`);
    }
    // Bugfixes must prove the bug with a new test; features and chores need none (the full suite must still be green on head).
    const needsProof = !opts.workClass || opts.workClass === "bugfix";
    if (needsProof && policy.testFileGlobs.length > 0 && newTestFiles.length === 0) {
      report.violations.push(`no new test file added matching ${policy.testFileGlobs.join(", ")}`);
    }
    if (report.violations.length > 0) {
      return report;
    }

    const headDir = path.join(tmpRoot, "head");
    const baseDir = path.join(tmpRoot, "base");
    await extractCommitTree(opts.repoDir, headSha, headDir, env);

    if (!opts.skipPreCommit) {
      const yamlPrimary = await readGitFileStrict(opts.repoDir, policySha, ".pre-commit-config.yaml", env);
      const yamlAlt = yamlPrimary
        ? null
        : await readGitFileStrict(opts.repoDir, policySha, ".pre-commit-config.yml", env);
      const preCommitYaml = yamlPrimary ?? yamlAlt;
      const preCommitName = yamlPrimary ? ".pre-commit-config.yaml" : ".pre-commit-config.yml";

      if (!preCommitYaml) {
        report.violations.push("missing .pre-commit-config.yaml on base commit (failing closed)");
        return report;
      } else {
        fs.writeFileSync(path.join(headDir, preCommitName), preCommitYaml, "utf8");
        const nonDeleted = stats.filter((s) => s.status !== "D").map((s) => s.path);
        const pc = await runRepoPreCommit(headDir, preCommitYaml, preCommitName, nonDeleted, timeoutMs, env);
        report.hooks_run = pc.hooksRun;
        report.violations.push(...pc.violations);
      }
    }

    if (report.violations.length > 0) {
      return report;
    }

    if (!opts.skipTests && policy.testCmd) {
      const testEnv: NodeJS.ProcessEnv = { ...env, ARCHANGEL_NEW_TEST_FILES: newTestFiles.join(" ") };
      const junitRe = policy.junitReport ? globToRegExp(policy.junitReport) : null;
      /** Test IDs of the new test files' cases from the red base run: every one must pass on head. */
      let expectedIds: string[] | null = null;
      // Feature and chore work has no bug to reproduce: skip the red-on-base proof and the new-test requirement. Everything else
      // (bounds, protected paths, hooks, full head suite) is enforced above and below exactly as for bugfixes.
      if (needsProof) {
        const baseCmd = policy.baseTestCmd ?? policy.testCmd;
        await extractCommitTree(opts.repoDir, baseSha, baseDir, env);

        const pristineEnv: NodeJS.ProcessEnv = { ...env, ARCHANGEL_NEW_TEST_FILES: "" };
        const pristineRes = await runShellCmd(baseDir, baseCmd, timeoutMs, pristineEnv);
        if (!pristineRes.ok) {
          report.violations.push(
            `pristine base testCmd failed — cannot prove new test caused failure: ${pristineRes.output
              .split("\n")
              .slice(0, 6)
              .join(" | ")}`,
          );
          return report;
        }

        for (const rel of overlayFiles) {
          const dest = path.join(baseDir, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const bytes = await readGitFileBuffer(opts.repoDir, headSha, rel, env);
          fs.writeFileSync(dest, bytes);
        }

        if (policy.testBuildCmd) {
          const buildRes = await runShellCmd(baseDir, policy.testBuildCmd, timeoutMs, testEnv);
          if (!buildRes.ok) {
            report.violations.push(
              `base build failed (new test must compile against base APIs): ${buildRes.output
                .split("\n")
                .slice(0, 6)
                .join(" | ")}`,
            );
            return report;
          }
        }

        for (let i = 1; i <= baseRuns; i++) {
          if (junitRe) clearReports(baseDir, junitRe);
          const baseTestRes = await runShellCmd(baseDir, baseCmd, timeoutMs, testEnv);
          if (baseTestRes.status === "timed_out" || baseTestRes.status === "exec_error") {
            report.violations.push(
              `base test command ${baseTestRes.status === "timed_out" ? "timed out" : "could not run"}: that does not prove the new test reproduces the bug (run ${i}/${baseRuns}); failing closed`,
            );
            return report;
          }
          if (!baseTestRes.ok && i === 1) report.proof = { base_output: tailOutput(baseTestRes.output) };
          // With a JUnit report, "red" means a test case from a NEW test file failed; any other failure is not proof.
          let red = !baseTestRes.ok;
          if (junitRe) {
            const jr = readReports(baseDir, junitRe);
            if ("error" in jr) {
              report.violations.push(`base JUnit report unusable (failing closed): ${jr.error}`);
              return report;
            }
            const mine = jr.cases.filter((c) => attributableTo(c, newTestFiles));
            if (mine.length === 0) {
              report.violations.push(
                `no test cases in the base JUnit report are attributable to the new test files (${newTestFiles.join(", ")}); failing closed`,
              );
              return report;
            }
            const failedIds = mine.filter((c) => c.status === "failed").map((c) => c.id);
            red = failedIds.length > 0;
            if (!red && !baseTestRes.ok) {
              report.violations.push(
                `base failed for reasons unrelated to the new tests: no test case from ${newTestFiles.join(", ")} failed (run ${i}/${baseRuns})`,
              );
              return report;
            }
            if (i === 1) {
              expectedIds = mine.map((c) => c.id);
              report.proof = { ...report.proof, junit: { base_failed: capIds(failedIds), head_passed: [] } };
            }
          }
          if (!red) {
            report.already_fixed = true;
            report.violations.push(
              `reproduction test already passed on base (run ${i}/${baseRuns}) — issue may already be fixed or test does not reproduce the bug`,
            );
            return report;
          }
        }

      }

      for (let i = 1; i <= headRuns; i++) {
        if (junitRe) clearReports(headDir, junitRe);
        const headTestRes = await runShellCmd(headDir, policy.testCmd, timeoutMs, testEnv);
        report.proof = { ...report.proof, head_output: tailOutput(headTestRes.output) };
        if (!headTestRes.ok) {
          report.violations.push(
            `head testCmd failed (run ${i}/${headRuns}): ${headTestRes.output
              .split("\n")
              .slice(0, 8)
              .join(" | ")}`,
          );
          return report;
        }
        if (junitRe && !(!needsProof && newTestFiles.length === 0)) {
          const jr = readReports(headDir, junitRe);
          if ("error" in jr) {
            report.violations.push(`head JUnit report unusable (failing closed): ${jr.error}`);
            return report;
          }
          const mine = jr.cases.filter((c) => attributableTo(c, newTestFiles));
          // Bugfix: every case that was red on base must be present and passed. Feature/chore (no base run): all attributable cases pass.
          const expected = expectedIds ?? mine.map((c) => c.id);
          const passed = new Set(mine.filter((c) => c.status === "passed").map((c) => c.id));
          const missing = expected.filter((id) => !passed.has(id));
          if (expected.length === 0 || missing.length > 0) {
            report.violations.push(
              expected.length === 0
                ? `no test cases in the head JUnit report are attributable to the new test files (${newTestFiles.join(", ")}); failing closed`
                : `head JUnit report lacks a passing result for new test case(s): ${capIds(missing).join(", ")}`,
            );
            return report;
          }
          report.proof = { ...report.proof, junit: { base_failed: report.proof?.junit?.base_failed ?? [], head_passed: capIds(expected) } };
        }
      }
    }

    report.passed = report.violations.length === 0;
    return report;
  } finally {
    removeTempTree(tmpRoot);
  }
}

function makeWritable(dir: string): void {
  fs.chmodSync(dir, 0o700);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) makeWritable(path.join(dir, entry.name));
  }
}

/** Go writes its module cache read-only; make the tree writable before removing it. A cleanup failure never changes a computed verdict. */
export function removeTempTree(dir: string): void {
  try {
    if (fs.existsSync(dir)) makeWritable(dir);
  } catch (err) {
    console.error(`archangel-gate: could not make ${dir} writable: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (err) {
    console.error(`archangel-gate: could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
