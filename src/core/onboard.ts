import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { LabelsSchema } from "../config.js";

const execFileP = promisify(execFile);

/** Everything external goes through here (the owner's `gh` and `git`), so tests never touch GitHub. */
export interface OnboardRunner {
  run(cmd: "gh" | "git", args: string[], opts?: { cwd?: string }): Promise<string>;
}

export const execRunner: OnboardRunner = {
  async run(cmd, args, opts) {
    const { stdout } = await execFileP(cmd, args, { cwd: opts?.cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  },
};

export type Stack = "go" | "node";

/** Tiny hardcoded table: a root file implies a stack. */
const STACK_MARKERS: Array<[string, Stack]> = [
  ["go.mod", "go"],
  ["package.json", "node"],
];

export function detectStack(paths: string[]): Stack | null {
  for (const [file, stack] of STACK_MARKERS) if (paths.includes(file)) return stack;
  return null;
}

/** Archangel checkout root (same resolution as bundled skills). */
export const ARCHANGEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const GATE_WORKFLOW_PATH = ".github/workflows/archangel-gate.yml";
export const POLICY_PATH = ".agents/archangel.json";
export const SCOUT_PATH = ".agents/scouts/bug-hunt.md";
export const ONBOARD_BRANCH = "chore/archangel-onboard";

export interface PlannedFile {
  path: string;
  content: string;
}

export interface OnboardPlan {
  repo: string;
  defaultBranch: string;
  stack: Stack | null;
  labelsToCreate: string[];
  files: PlannedFile[];
  skipped: string[];
  notes: string[];
}

/** Refuses unless the Archangel checkout is clean and HEAD is on origin/main; returns the pin. */
export async function pinnedSha(runner: OnboardRunner, root: string, what = "onboard"): Promise<string> {
  if ((await runner.run("git", ["status", "--porcelain"], { cwd: root })).trim() !== "") {
    throw new Error(`Refusing to ${what}: the Archangel checkout has uncommitted changes.`);
  }
  await runner.run("git", ["fetch", "origin", "main", "--quiet"], { cwd: root });
  const sha = (await runner.run("git", ["rev-parse", "HEAD"], { cwd: root })).trim();
  try {
    await runner.run("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { cwd: root });
  } catch {
    throw new Error(`Refusing to ${what}: Archangel HEAD ${sha.slice(0, 10)} is not on origin/main (the Gate pin must be fetchable).`);
  }
  return sha;
}

function guessTestGlobs(paths: string[]): string[] {
  const exts = new Set<string>();
  for (const p of paths) {
    const m = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/.exec(p);
    if (m) exts.add(`**/*.${m[1]}.${m[2]}`);
  }
  return [...exts].sort();
}

function bugHuntSkills(stack: Stack | null): string[] {
  return ["general/bug-hunt", "general/input-validation", ...(stack === "go" ? ["go/*"] : stack === "node" ? ["typescript/*"] : [])];
}

/** The Scout prompt body: plain Markdown, no frontmatter. The Scout's settings live in the workflow file. */
const BUG_HUNT_PROMPT = `Audit the repository's non-test production source for concrete, reproducible bugs.
Only propose an issue if you can name the exact file and symbol, the failing behaviour, the expected behaviour, and a new test that fails today.
`;

/** Adds the bug-hunt Scout entry to a workflow starter, keeping the starter's own key order. */
function withBugHuntScout(workflowJson: string, stack: Stack | null): string {
  const wf = JSON.parse(workflowJson) as Record<string, unknown>;
  wf.scouts = [{ name: "bug-hunt", schedule: "daily", maxProposals: 2, skills: bugHuntSkills(stack) }];
  return JSON.stringify(wf, null, 2) + "\n";
}

/**
 * Builds the plan from reads only. Existing files are never overwritten (only missing ones are planned).
 * The `.agents/archangel.json` starter is only planned when it can be derived without guessing.
 */
export async function buildPlan(
  runner: OnboardRunner,
  repo: string,
  opts: { archangelRoot?: string } = {},
): Promise<OnboardPlan> {
  const root = opts.archangelRoot ?? ARCHANGEL_ROOT;
  const sha = await pinnedSha(runner, root);
  const defaultBranch = (await runner.run("gh", ["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).trim();
  const tree = (await runner.run("gh", ["api", `repos/${repo}/git/trees/${defaultBranch}?recursive=1`, "--jq", ".tree[].path"]))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const have = new Set(tree);
  const stack = detectStack(tree);

  const existingLabels = new Set(
    (await runner.run("gh", ["label", "list", "--repo", repo, "--limit", "200", "--json", "name", "-q", ".[].name"]))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const labelsToCreate = Object.values(LabelsSchema.parse({})).filter((l) => !existingLabels.has(l));

  const files: PlannedFile[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];
  const consider = (p: string, content: () => string | null) => {
    if (have.has(p)) {
      skipped.push(`${p} (already exists)`);
      return;
    }
    const c = content();
    if (c !== null) files.push({ path: p, content: c });
  };

  consider(GATE_WORKFLOW_PATH, () =>
    fs
      .readFileSync(path.join(root, "workflows/archangel-gate.yml"), "utf8")
      .replace(/^(\s*ARCHANGEL_GATE_SHA:).*$/m, `$1 ${sha}`),
  );

  consider(POLICY_PATH, () => {
    if (stack === "go") {
      return withBugHuntScout(fs.readFileSync(path.join(root, "templates/go/.agents/archangel.json"), "utf8"), stack);
    }
    if (stack === "node") {
      return null; // filled below, needs package.json
    }
    notes.push(`Unknown stack: write ${POLICY_PATH} by hand (see templates/go/.agents/archangel.json for the shape).`);
    return null;
  });
  if (stack === "node" && !have.has(POLICY_PATH)) {
    const globs = guessTestGlobs(tree);
    const pkgRaw = await runner.run("gh", ["api", `repos/${repo}/contents/package.json?ref=${defaultBranch}`, "-H", "Accept: application/vnd.github.raw"]);
    const testScript = (JSON.parse(pkgRaw) as { scripts?: { test?: string } }).scripts?.test;
    if (!testScript || globs.length === 0) {
      notes.push(
        `Node repo without ${!testScript ? "a package.json scripts.test" : "any *.test.* / *.spec.* files"}: write ${POLICY_PATH} by hand once tests exist.`,
      );
    } else {
      const protectedPaths = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json"].filter((f) => have.has(f));
      files.push({
        path: POLICY_PATH,
        content: withBugHuntScout(
          JSON.stringify({
            version: 1,
            gate: { testFileGlobs: globs, testCmd: "npm test", protectedPaths },
            requiredChecks: ["Test"],
          }),
          stack,
        ),
      });
    }
  }

  // The Scout prompt only works together with its entry in the workflow file, so it is planned with a new one.
  if (files.some((f) => f.path === POLICY_PATH)) consider(SCOUT_PATH, () => BUG_HUNT_PROMPT);
  else if (have.has(POLICY_PATH)) {
    notes.push(`${POLICY_PATH} exists: add a Scout entry and ${SCOUT_PATH} by hand if you want the bug-hunt Scout.`);
  }

  return { repo, defaultBranch, stack, labelsToCreate, files, skipped, notes };
}

export function printPlan(plan: OnboardPlan, log: (s: string) => void): void {
  log(`Onboarding ${plan.repo} (default branch ${plan.defaultBranch}, stack: ${plan.stack ?? "unknown"})`);
  log(`Labels to create: ${plan.labelsToCreate.join(", ") || "none (all exist)"}`);
  log(`Files to add on ${ONBOARD_BRANCH}: ${plan.files.map((f) => f.path).join(", ") || "none"}`);
  for (const s of plan.skipped) log(`Skipped: ${s}`);
  for (const n of plan.notes) log(`Note: ${n}`);
}

export function printOwnerSteps(repo: string, defaultBranch: string, log: (s: string) => void): void {
  log("");
  log("Owner steps (not done by this command):");
  log("1. Add to archangel.yaml under projects:");
  log(`   - repo: ${repo}`);
  log(`     defaultBranch: ${defaultBranch}`);
  log("     scouts:");
  log("       enabled: false");
  log(`2. Merge the onboarding PR, then protect ${defaultBranch}: require status checks "Gate" and "Test" (your CI job name), PRs before merging.`);
  log("3. Install the Archangel GitHub App on the repo.");
}

/** Applies the plan with the owner's `gh`. Idempotent: existing labels, an open onboarding PR, and existing files are left alone. */
export async function applyPlan(runner: OnboardRunner, plan: OnboardPlan, log: (s: string) => void): Promise<void> {
  const { repo } = plan;
  for (const label of plan.labelsToCreate) {
    log(`Creating label ${label}`);
    await runner.run("gh", ["label", "create", label, "--repo", repo, "--color", "ededed", "--description", "Archangel factory label"]);
  }
  if (plan.files.length === 0) {
    log("No files to add.");
    return;
  }
  const open = (
    await runner.run("gh", ["pr", "list", "--repo", repo, "--head", ONBOARD_BRANCH, "--state", "open", "--json", "url", "-q", ".[0].url"])
  ).trim();
  if (open) {
    log(`Onboarding PR already open: ${open}`);
    return;
  }
  const baseSha = (await runner.run("gh", ["api", `repos/${repo}/git/ref/heads/${plan.defaultBranch}`, "--jq", ".object.sha"])).trim();
  log(`Creating branch ${ONBOARD_BRANCH}`);
  await runner.run("gh", ["api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${ONBOARD_BRANCH}`, "-f", `sha=${baseSha}`]);
  for (const f of plan.files) {
    log(`Adding ${f.path}`);
    await runner.run("gh", [
      "api",
      "-X",
      "PUT",
      `repos/${repo}/contents/${f.path}`,
      "-f",
      `message=chore: add ${f.path} (Archangel onboarding)`,
      "-f",
      `content=${Buffer.from(f.content).toString("base64")}`,
      "-f",
      `branch=${ONBOARD_BRANCH}`,
    ]);
  }
  const url = (
    await runner.run("gh", [
      "pr",
      "create",
      "--repo",
      repo,
      "--head",
      ONBOARD_BRANCH,
      "--base",
      plan.defaultBranch,
      "--title",
      "chore: onboard to Archangel",
      "--body",
      `Adds the Archangel Gate workflow (pinned), repo policy and a bug-hunt Scout. Review and merge manually; nothing here merges itself.\n\nFiles: ${plan.files.map((f) => f.path).join(", ")}`,
    ])
  ).trim();
  log(`Opened ${url}`);
}

export async function onboard(
  runner: OnboardRunner,
  repo: string,
  opts: { dryRun?: boolean; log?: (s: string) => void; archangelRoot?: string } = {},
): Promise<OnboardPlan> {
  const log = opts.log ?? console.log;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Expected owner/name, got '${repo}'`);
  const plan = await buildPlan(runner, repo, { archangelRoot: opts.archangelRoot });
  printPlan(plan, log);
  if (opts.dryRun) {
    log("Dry run: nothing changed.");
  } else {
    await applyPlan(runner, plan, log);
  }
  printOwnerSteps(repo, plan.defaultBranch, log);
  return plan;
}
