import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_POLICY_PATH, REPO_SLUG_RE } from "../config.js";

const execFileP = promisify(execFile);

export type BumpCmd = "gh" | "git" | "bun" | "npm" | "go" | "govulncheck" | "sh";

/** Everything external goes through here, so tests never touch the network. `env` replaces the process environment when given. */
export interface BumpRunner {
  run(cmd: BumpCmd, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<string>;
}

export const bumpRunner: BumpRunner = {
  async run(cmd, args, opts) {
    const { stdout, stderr } = await execFileP(cmd, args, { cwd: opts?.cwd, env: opts?.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return stdout + stderr;
  },
};

export type BumpEcosystem = "bun" | "npm" | "go";
export type BumpLevel = "patch" | "minor";

/** Exactly one root marker names the ecosystem; anything else is refused, never guessed. */
export function detectEcosystem(files: string[]): BumpEcosystem {
  const found = (
    [
      ["bun.lock", "bun"],
      ["package-lock.json", "npm"],
      ["go.mod", "go"],
    ] as const
  ).filter(([f]) => files.includes(f));
  if (found.length === 0) throw new Error("Unsupported ecosystem: need bun.lock, package-lock.json or go.mod at the repo root (pnpm, yarn and others are not supported).");
  if (found.length > 1) throw new Error(`Ambiguous ecosystem: found ${found.map(([f]) => f).join(" and ")}; refusing to guess.`);
  return found[0]![1];
}

/** Lifecycle scripts never run: every install and update of a node ecosystem passes `--ignore-scripts`. Go has none. */
export function installCommands(eco: BumpEcosystem, level: BumpLevel, pkgs: string[]): Array<{ cmd: BumpCmd; args: string[] }> {
  if (eco === "bun") return [{ cmd: "bun", args: ["install", "--ignore-scripts", "--frozen-lockfile"] }, { cmd: "bun", args: ["update", "--ignore-scripts", ...pkgs] }];
  if (eco === "npm") return [{ cmd: "npm", args: ["ci", "--ignore-scripts"] }, { cmd: "npm", args: ["update", "--ignore-scripts", ...pkgs] }];
  return [
    { cmd: "go", args: ["get", level === "patch" ? "-u=patch" : "-u", ...(pkgs.length > 0 ? pkgs : ["./..."])] },
    { cmd: "go", args: ["mod", "tidy"] },
  ];
}

const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

function directRanges(pkgJson: string): Map<string, string> {
  const j = JSON.parse(pkgJson) as Record<string, Record<string, string> | undefined>;
  const out = new Map<string, string>();
  for (const s of DEP_SECTIONS) for (const [name, range] of Object.entries(j[s] ?? {})) out.set(name, range);
  return out;
}

const RANGE_RE = /^[\^~]?(\d+)\.(\d+)\.(\d+)/;

/** `--patch` for node repos: every changed direct dependency must keep its major and minor. Transitive packages are not limited. */
export function patchViolations(before: string, after: string): string[] {
  const b = directRanges(before);
  const out: string[] = [];
  for (const [name, range] of directRanges(after)) {
    const old = b.get(name);
    if (old === undefined || old === range) continue;
    const o = RANGE_RE.exec(old);
    const n = RANGE_RE.exec(range);
    if (!o || !n || o[1] !== n[1] || o[2] !== n[2]) out.push(`${name} ${old} -> ${range}`);
  }
  return out;
}

const AUDIT: Record<BumpEcosystem, { cmd: BumpCmd; args: string[] }> = {
  bun: { cmd: "bun", args: ["audit"] },
  npm: { cmd: "npm", args: ["audit", "--audit-level=high"] },
  go: { cmd: "govulncheck", args: ["./..."] },
};

async function attempt(runner: BumpRunner, cmd: BumpCmd, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ ok: boolean; output: string }> {
  try {
    return { ok: true, output: await runner.run(cmd, args, opts) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? String(err)) };
  }
}

const tail = (s: string, n = 20) => s.trim().split("\n").slice(-n).join("\n");

export interface BumpInput {
  repo: string;
  level: BumpLevel;
  pkgs: string[];
  yes: boolean;
  confirm: (q: string) => Promise<boolean>;
  log: (s: string) => void;
  now?: number;
}

/**
 * Owner-run package bump: clone to a throwaway dir, update with lifecycle scripts off, audit, run the repo's own testCmd with a scrubbed
 * environment, show the diff, and on confirmation open an owner-authored PR on a non-`factory/*` branch. Never runs in the daemon and
 * never merges. Returns the PR URL.
 */
export async function bump(runner: BumpRunner, input: BumpInput): Promise<string> {
  if (!REPO_SLUG_RE.test(input.repo)) throw new Error(`Expected owner/name, got '${input.repo}'`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-bump-"));
  try {
    const dir = path.join(tmp, "repo");
    // No gh/GitHub credentials, no real HOME: install, audit and the repo's tests run with nothing but PATH.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: path.join(tmp, "home"), CI: "1" };
    fs.mkdirSync(env.HOME!);
    await runner.run("gh", ["repo", "clone", input.repo, dir, "--", "--depth=1"]);
    const base = (await runner.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir })).trim();
    const eco = detectEcosystem(fs.readdirSync(dir));
    const policyFile = path.join(dir, REPO_POLICY_PATH);
    if (!fs.existsSync(policyFile)) throw new Error(`${input.repo} has no ${REPO_POLICY_PATH}; refusing to bump without a testCmd to prove it.`);
    const testCmd = (JSON.parse(fs.readFileSync(policyFile, "utf8")) as { gate?: { testCmd?: string } }).gate?.testCmd;
    if (!testCmd) throw new Error(`${REPO_POLICY_PATH} has no gate.testCmd; refusing to bump without a test command.`);

    const pkgJsonPath = path.join(dir, "package.json");
    const before = eco === "go" ? "" : fs.readFileSync(pkgJsonPath, "utf8");
    for (const c of installCommands(eco, input.level, input.pkgs)) await runner.run(c.cmd, c.args, { cwd: dir, env });
    if (eco !== "go" && input.level === "patch") {
      const bad = patchViolations(before, fs.readFileSync(pkgJsonPath, "utf8"));
      if (bad.length > 0) throw new Error(`--patch refused: these direct dependencies moved past a patch release (rerun with --minor): ${bad.join("; ")}`);
    }

    const diff = (await runner.run("git", ["diff", "--stat"], { cwd: dir })).trim();
    if (!diff) throw new Error("Nothing to bump: the update changed no files.");
    const audit = await attempt(runner, AUDIT[eco].cmd, AUDIT[eco].args, { cwd: dir, env });
    const tests = await attempt(runner, "sh", ["-c", testCmd], { cwd: dir, env });
    if (!tests.ok) throw new Error(`testCmd (${testCmd}) failed after the bump; nothing was opened.\n${tail(tests.output)}`);

    const manifest = (await runner.run("git", ["diff", "-U0", "--", eco === "go" ? "go.mod" : "package.json"], { cwd: dir })).trim();
    const auditLine = audit.ok ? "clean" : `FINDINGS (audit exited non-zero)\n${tail(audit.output)}`;
    input.log(`----- ${eco} bump of ${input.repo} (${input.level}${input.pkgs.length > 0 ? `: ${input.pkgs.join(", ")}` : ""}) -----\n${diff}\n\n${manifest}\n\naudit: ${auditLine}\ntestCmd \`${testCmd}\`: passed\n`);
    if (!input.yes && !(await input.confirm(`Open an owner-authored bump PR against ${base} on ${input.repo}? [y/N] `))) {
      throw new Error("Not confirmed; nothing was opened.");
    }

    const stamp = new Date(input.now ?? Date.now()).toISOString().replace(/[-:T]/g, "").slice(0, 12);
    const branch = `chore/bump-${eco}-${stamp}`;
    await runner.run("git", ["checkout", "-b", branch], { cwd: dir });
    await runner.run("git", ["add", "-A"], { cwd: dir });
    await runner.run("git", ["commit", "-m", `chore: bump ${eco} dependencies (${input.level})`], { cwd: dir });
    await runner.run("git", ["push", "origin", branch], { cwd: dir });
    const body = [
      `Package bump prepared by \`archangel bump\` in a throwaway clone with lifecycle scripts disabled, then opened with the owner's \`gh\`.`,
      "",
      `- Level: ${input.level}${input.pkgs.length > 0 ? `, packages: ${input.pkgs.join(", ")}` : ""}`,
      `- \`${testCmd}\`: passed`,
      `- Audit: ${auditLine}`,
      "",
      "```",
      diff,
      "```",
    ].join("\n");
    return (await runner.run("gh", ["pr", "create", "--repo", input.repo, "--base", base, "--head", branch, "--title", `chore: bump ${eco} dependencies (${input.level})`, "--body", body])).trim();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
