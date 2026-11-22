import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { GatePolicySchema, REPO_POLICY_PATH, type GatePolicy } from "../config.js";
import { UNIVERSAL_PROTECTED_EXACT, UNIVERSAL_PROTECTED_PREFIXES, Workflow } from "../core/workflow.js";

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
}

export const GATE_PROOF_ANNOTATION_TITLE = "archangel-gate-proof";
export const PROOF_MAX_LINES = 40;
export const PROOF_MAX_CHARS = 3000;

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
): Promise<GateReport> {
  log(`::stop-commands::${token}`);
  const report = await run(opts);
  log(JSON.stringify(report, null, 2));
  log(`::${token}::`);
  if (report.proof) {
    const message = JSON.stringify({ head_sha: report.head_sha, ...report.proof })
      .replace(/%/g, "%25")
      .replace(/\r/g, "%0D")
      .replace(/\n/g, "%0A");
    log(`::notice title=${GATE_PROOF_ANNOTATION_TITLE}::${message}`);
  }
  return report;
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
  policy?: Partial<GatePolicy>;
  policyFromBase?: boolean;
  revertOf?: string;
  baseRunsOverride?: number;
  headRunsOverride?: number;
  skipPreCommit?: boolean;
  skipTests?: boolean;
  commandTimeoutMs?: number;
  /** `feature` skips the red-on-base requirement only. Defaults to `bugfix` (full reproduction proof). */
  workClass?: "bugfix" | "feature";
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

async function gitObjectExists(repoDir: string, spec: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await runGit(repoDir, ["cat-file", "-e", spec], env);
    return true;
  } catch {
    return false;
  }
}

async function readGitFileStrict(
  repoDir: string,
  ref: string,
  relPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const exists = await gitObjectExists(repoDir, `${ref}:${relPath}`, env);
  if (!exists) return null;
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
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-eu", "-c", cmd], {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: 20 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || e.message || String(err);
    return { ok: false, output: out };
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
    const { stdout, stderr } = await execFileAsync("/bin/sh", args, {
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
  const topInclude = typeof parsed.files === "string" ? new RegExp(parsed.files) : null;
  const topExclude = typeof parsed.exclude === "string" ? new RegExp(parsed.exclude) : null;

  const beforeHashes = new Map<string, string | null>();
  for (const rel of changedFiles) {
    beforeHashes.set(rel, hashFileIfExists(path.join(worktreeDir, rel)));
  }

  // 1. Strictly run `repo: local` + `language: system` hooks natively; fail closed on unsupported keys/languages.
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

      const includeRe = hook.files ? new RegExp(hook.files) : null;
      const excludeRe = hook.exclude ? new RegExp(hook.exclude) : null;
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

  // 2. Delegate remote hook repos strictly to the official `pre-commit` CLI (fail closed if absent).
  if (remoteRepos.length > 0 && changedFiles.length > 0) {
    const remoteConfigPath = path.join(worktreeDir, ".archangel-remote-pre-commit.yaml");
    fs.writeFileSync(remoteConfigPath, JSON.stringify({ repos: remoteRepos }, null, 2), "utf8");
    try {
      await execFileAsync("git", ["init", "-q"], { cwd: worktreeDir, env });
      await execFileAsync("git", ["add", "-A"], { cwd: worktreeDir, env });
      await execFileAsync(
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

  // 3. Reject hooks that mutated the checked-out HEAD tree (e.g. `gofmt -w` hiding unformatted code).
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
 * - Fail-closed under `--policy-from-base`: requires strict `.agents/archangel.json`, non-empty `testFileGlobs`,
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

    let policy = GatePolicySchema.parse(opts.policy ?? {});
    if (opts.policyFromBase) {
      const repoPolicyRaw = await readGitFileStrict(opts.repoDir, baseSha, REPO_POLICY_PATH, env);
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
      const g = parsed.data.gate;
      policy = GatePolicySchema.parse({
        maxNonTestLines: g.maxNonTestLines,
        maxTotalLines: g.maxTotalLines,
        maxFiles: g.maxFiles,
        extraProtectedPaths: g.protectedPaths,
        testFileGlobs: g.testFileGlobs,
        testDataGlobs: g.testDataGlobs,
        testBuildCmd: g.testBuildCmd,
        baseTestCmd: g.baseTestCmd,
        testCmd: g.testCmd,
        baseTestRuns: g.baseTestRuns,
        headTestRuns: g.headTestRuns,
      });
    }

    const baseRuns = opts.baseRunsOverride ?? policy.baseTestRuns;
    const headRuns = opts.headRunsOverride ?? policy.headTestRuns;

    // 1. Exact-inverse revert exemption (H5: require revert target === baseSha so later commits can never be silently dropped).
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

    // 2. Diff budget, protected paths, and pre-existing test-file & test-fixture immutability.
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
    if (policy.testFileGlobs.length > 0 && newTestFiles.length === 0) {
      report.violations.push(`no new test file added matching ${policy.testFileGlobs.join(", ")}`);
    }
    if (report.violations.length > 0) {
      return report;
    }

    // 3. Extract HEAD and run repo-owned `.pre-commit-config.yaml` strictly from `baseSha`.
    const headDir = path.join(tmpRoot, "head");
    const baseDir = path.join(tmpRoot, "base");
    await extractCommitTree(opts.repoDir, headSha, headDir, env);

    if (!opts.skipPreCommit) {
      const yamlPrimary = await readGitFileStrict(opts.repoDir, baseSha, ".pre-commit-config.yaml", env);
      const yamlAlt = yamlPrimary
        ? null
        : await readGitFileStrict(opts.repoDir, baseSha, ".pre-commit-config.yml", env);
      const preCommitYaml = yamlPrimary ?? yamlAlt;
      const preCommitName = yamlPrimary ? ".pre-commit-config.yaml" : ".pre-commit-config.yml";

      if (!preCommitYaml) {
        if (opts.policyFromBase) {
          report.violations.push("missing .pre-commit-config.yaml on base commit (failing closed)");
          return report;
        }
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

    // 4. Language-agnostic Pristine-Base-Green -> Overlaid-Base-Red -> Head-Green verification.
    if (!opts.skipTests && policy.testCmd) {
      const testEnv: NodeJS.ProcessEnv = { ...env, ARCHANGEL_NEW_TEST_FILES: newTestFiles.join(" ") };
      // Feature work has no bug to reproduce: skip the red-on-base proof. Everything else (new test file,
      // bounds, protected paths, hooks, head tests) is enforced above and below exactly as for bugfixes.
      if (opts.workClass !== "feature") {
        const baseCmd = policy.baseTestCmd ?? policy.testCmd;
        await extractCommitTree(opts.repoDir, baseSha, baseDir, env);

        // 4a. Pristine base must be green first — ties the subsequent failure directly to the new test overlay.
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

        // 4b. Overlay newly added test files + fixtures onto baseDir.
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
          const baseTestRes = await runShellCmd(baseDir, baseCmd, timeoutMs, testEnv);
          if (!baseTestRes.ok && i === 1) report.proof = { base_output: tailOutput(baseTestRes.output) };
          if (baseTestRes.ok) {
            report.already_fixed = true;
            report.violations.push(
              `reproduction test already passed on base (run ${i}/${baseRuns}) — issue may already be fixed or test does not reproduce the bug`,
            );
            return report;
          }
        }

      }

      // 4c. Green-on-HEAD (fresh tree verified unmodified by hooks).
      for (let i = 1; i <= headRuns; i++) {
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
      }
    }

    report.passed = report.violations.length === 0;
    return report;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
