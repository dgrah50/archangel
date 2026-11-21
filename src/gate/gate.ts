import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  GatePolicySchema,
  LandingJsonSchema,
  mergeLandingJson,
  type GatePolicy,
} from "../config.js";

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

/**
 * Universal, language-agnostic protected paths.
 * Language/repo-specific paths (e.g. go.mod, package-lock.json, Makefile) belong in
 * `.agents/landing.json` (`extraProtectedPaths`) or `archangel.yaml`.
 */
const UNIVERSAL_PROTECTED_PREFIXES = [".github/", ".agents/"];
const UNIVERSAL_PROTECTED_EXACT = new Set([
  ".pre-commit-config.yaml",
  ".pre-commit-config.yml",
  ".gitattributes",
  ".gitmodules",
  "claude.md",
  "agents.md",
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

export function isTestOrFixtureFile(
  relPath: string,
  policy: Pick<GatePolicy, "testFileGlobs" | "testDataGlobs">,
): boolean {
  return (
    isTestFile(relPath, policy) ||
    (policy.testDataGlobs.length > 0 && matchesAnyGlob(relPath, policy.testDataGlobs))
  );
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
}

interface PreCommitHook {
  id: string;
  name?: string;
  entry: string;
  language?: string;
  files?: string;
  exclude?: string;
  pass_filenames?: boolean;
  stages?: string[];
}

interface PreCommitRepo {
  repo: string;
  rev?: string;
  hooks?: PreCommitHook[];
}

interface PreCommitConfig {
  repos?: PreCommitRepo[];
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const goCacheDir = path.join(os.tmpdir(), "archangel-go-build-cache");
  fs.mkdirSync(goCacheDir, { recursive: true });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GOCACHE: goCacheDir,
    ...(process.env.GOMODCACHE ? { GOMODCACHE: process.env.GOMODCACHE } : {}),
  };
}

async function runGit(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...HARDENED_GIT_FLAGS, ...args], {
    cwd: repoDir,
    env: scrubbedEnv(),
    maxBuffer: 25 * 1024 * 1024,
  });
  return stdout;
}

async function readGitFile(repoDir: string, ref: string, relPath: string): Promise<string | null> {
  try {
    return await runGit(repoDir, ["show", `${ref}:${relPath}`]);
  } catch {
    return null;
  }
}

async function readGitFileBuffer(repoDir: string, ref: string, relPath: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "git",
    [...HARDENED_GIT_FLAGS, "show", `${ref}:${relPath}`],
    {
      cwd: repoDir,
      env: scrubbedEnv(),
      encoding: "buffer",
      maxBuffer: 25 * 1024 * 1024,
    },
  );
  return stdout;
}

async function isAncestor(repoDir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await runGit(repoDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

async function extractCommitTree(repoDir: string, sha: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  // Use `git archive` + `tar` so extraction works cleanly on BOTH bare and normal repos with zero hooks.
  await execFileAsync(
    "/bin/sh",
    ["-eu", "-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "--", repoDir, sha, destDir],
    { env: scrubbedEnv(), maxBuffer: 25 * 1024 * 1024 },
  );
}

async function getDiffStats(repoDir: string, baseSha: string, headSha: string): Promise<GateFileStat[]> {
  const [numstatRaw, statusRaw] = await Promise.all([
    runGit(repoDir, ["diff", "--numstat", "--no-renames", "-z", baseSha, headSha]),
    runGit(repoDir, ["diff", "--name-status", "--no-renames", "-z", baseSha, headSha]),
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
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-eu", "-c", cmd], {
      cwd,
      env: scrubbedEnv(),
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
): Promise<{ ok: boolean; output: string }> {
  const passFilenames = hook.pass_filenames !== false;
  try {
    const cmd = passFilenames ? `${hook.entry} "$@"` : hook.entry;
    const args = passFilenames ? ["-eu", "-c", cmd, "--", ...files] : ["-eu", "-c", cmd];
    const { stdout, stderr } = await execFileAsync("/bin/sh", args, {
      cwd,
      env: scrubbedEnv(),
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

async function runRepoPreCommit(
  worktreeDir: string,
  configRaw: string,
  configFilename: string,
  changedFiles: string[],
  timeoutMs: number,
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

  // 1. Run `repo: local` hooks directly (works with zero Python/pre-commit install!).
  for (const repo of localRepos) {
    for (const hook of repo.hooks ?? []) {
      const stages = hook.stages ?? [];
      if (stages.length > 0 && !stages.includes("pre-commit") && !stages.includes("commit") && !stages.includes("pre-merge-commit")) {
        continue;
      }
      const includeRe = hook.files ? new RegExp(hook.files) : null;
      const excludeRe = hook.exclude ? new RegExp(hook.exclude) : null;
      const matched = changedFiles.filter((f) => {
        if (includeRe && !includeRe.test(f)) return false;
        if (excludeRe && excludeRe.test(f)) return false;
        return true;
      });
      if (matched.length === 0) continue;

      hooksRun.push(hook.id);
      const res = await runLocalPreCommitHook(worktreeDir, hook, matched, timeoutMs);
      if (!res.ok) {
        const snippet = res.output.split("\n").slice(0, 8).join(" | ");
        violations.push(`pre-commit hook '${hook.id}' failed: ${snippet}`);
      }
    }
  }

  // 2. If the repo also declares external hook repos, delegate them to the official `pre-commit` CLI.
  if (remoteRepos.length > 0 && changedFiles.length > 0) {
    const remoteConfigPath = path.join(worktreeDir, ".archangel-remote-pre-commit.yaml");
    fs.writeFileSync(remoteConfigPath, JSON.stringify({ repos: remoteRepos }, null, 2), "utf8");
    try {
      // pre-commit requires a git repo; initialize a minimal temporary repo around the extracted tree.
      await execFileAsync("git", ["init", "-q"], { cwd: worktreeDir, env: scrubbedEnv() });
      await execFileAsync("git", ["add", "-A"], { cwd: worktreeDir, env: scrubbedEnv() });
      await execFileAsync(
        "pre-commit",
        ["run", "--config", remoteConfigPath, "--files", ...changedFiles],
        { cwd: worktreeDir, env: scrubbedEnv(), timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
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

  return { hooksRun, violations };
}

/**
 * Language-agnostic Archangel Mechanical Gate (ADR-0003 revised):
 * - Enforces diff bounds, protected paths, and pre-existing test-file immutability.
 * - Executes repo-owned `.pre-commit-config.yaml` read strictly from `base`.
 * - Verifies repo-owned `testBuildCmd` (pass) + `testCmd` (fail N×) on `base` with new tests overlaid,
 *   and `testCmd` (pass M×) on `HEAD`.
 */
export async function runGate(opts: GateRunOptions): Promise<GateReport> {
  const timeoutMs = opts.commandTimeoutMs ?? 5 * 60_000;
  const baseSha = (await runGit(opts.repoDir, ["rev-parse", `${opts.baseRef}^{commit}`])).trim();
  const headSha = (await runGit(opts.repoDir, ["rev-parse", `${opts.headRef}^{commit}`])).trim();

  let policy = GatePolicySchema.parse(opts.policy ?? {});
  if (opts.policyFromBase) {
    const landingRaw = await readGitFile(opts.repoDir, baseSha, ".agents/landing.json");
    if (landingRaw) {
      // Validate strict JSON schema before tightening-only merge.
      LandingJsonSchema.parse(JSON.parse(landingRaw));
      policy = mergeLandingJson(policy, [], undefined, landingRaw).gate;
    }
  }

  const baseRuns = opts.baseRunsOverride ?? policy.baseTestRuns;
  const headRuns = opts.headRunsOverride ?? policy.headTestRuns;
  const stats = await getDiffStats(opts.repoDir, baseSha, headSha);

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

  // 1. Exact-inverse revert exemption (with ancestry proof).
  if (opts.revertOf) {
    const revertSha = (await runGit(opts.repoDir, ["rev-parse", `${opts.revertOf}^{commit}`])).trim();
    const anc = await isAncestor(opts.repoDir, revertSha, baseSha);
    if (!anc) {
      report.violations.push(`revert target ${revertSha} is not an ancestor of base ${baseSha}`);
      return report;
    }
    const parentTree = (await runGit(opts.repoDir, ["rev-parse", `${revertSha}^^{tree}`])).trim();
    const headTree = (await runGit(opts.repoDir, ["rev-parse", `${headSha}^{tree}`])).trim();
    if (parentTree !== headTree) {
      report.violations.push("revert PR tree does not match exact inverse of reverted commit");
      return report;
    }
    report.revert_exempt = true;
    if (!opts.skipTests && policy.testCmd) {
      const tmpHead = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-gate-rev-"));
      try {
        await extractCommitTree(opts.repoDir, headSha, tmpHead);
        const res = await runShellCmd(tmpHead, policy.testCmd, timeoutMs);
        if (!res.ok) {
          report.violations.push(`revert testCmd failed: ${res.output.split("\n").slice(0, 6).join(" | ")}`);
          return report;
        }
      } finally {
        fs.rmSync(tmpHead, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
    report.passed = true;
    return report;
  }

  // 2. Diff budget, protected paths, and pre-existing test-file immutability.
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
    } else if (
      policy.testDataGlobs.length > 0 &&
      matchesAnyGlob(st.path, policy.testDataGlobs) &&
      st.status !== "D"
    ) {
      overlayFiles.push(st.path);
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
    report.violations.push(
      `no new test file added matching ${policy.testFileGlobs.join(", ")}`,
    );
  }
  if (report.violations.length > 0) {
    return report;
  }

  // 3. Extract HEAD and run repo-owned `.pre-commit-config.yaml` strictly from `baseSha`.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-gate-"));
  const headDir = path.join(tmpRoot, "head");
  const baseDir = path.join(tmpRoot, "base");

  try {
    await extractCommitTree(opts.repoDir, headSha, headDir);

    if (!opts.skipPreCommit) {
      const preCommitYaml =
        (await readGitFile(opts.repoDir, baseSha, ".pre-commit-config.yaml")) ??
        (await readGitFile(opts.repoDir, baseSha, ".pre-commit-config.yml"));
      const preCommitName = (await readGitFile(opts.repoDir, baseSha, ".pre-commit-config.yaml"))
        ? ".pre-commit-config.yaml"
        : ".pre-commit-config.yml";

      if (preCommitYaml) {
        // Always pin pre-commit config to baseSha inside headDir.
        fs.writeFileSync(path.join(headDir, preCommitName), preCommitYaml, "utf8");
        const nonDeleted = stats.filter((s) => s.status !== "D").map((s) => s.path);
        const pc = await runRepoPreCommit(headDir, preCommitYaml, preCommitName, nonDeleted, timeoutMs);
        report.hooks_run = pc.hooksRun;
        report.violations.push(...pc.violations);
      }
    }

    if (report.violations.length > 0) {
      return report;
    }

    // 4. Language-agnostic Red-on-base -> Green-on-HEAD verification.
    if (!opts.skipTests && policy.testCmd) {
      // 4a. Red-on-base: overlay new test files + test data onto baseSha.
      await extractCommitTree(opts.repoDir, baseSha, baseDir);
      for (const rel of overlayFiles) {
        const dest = path.join(baseDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const bytes = await readGitFileBuffer(opts.repoDir, headSha, rel);
        fs.writeFileSync(dest, bytes);
      }

      // Compile check on base (if configured): proves the new test compiles against base APIs.
      if (policy.testBuildCmd) {
        const buildRes = await runShellCmd(baseDir, policy.testBuildCmd, timeoutMs);
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
        const baseTestRes = await runShellCmd(baseDir, policy.testCmd, timeoutMs);
        if (baseTestRes.ok) {
          report.already_fixed = true;
          report.violations.push(
            `reproduction test already passed on base (run ${i}/${baseRuns}) — issue may already be fixed or test does not reproduce the bug`,
          );
          return report;
        }
      }

      // 4b. Green-on-HEAD: full testCmd must pass headRuns times uncached.
      for (let i = 1; i <= headRuns; i++) {
        const headTestRes = await runShellCmd(headDir, policy.testCmd, timeoutMs);
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
