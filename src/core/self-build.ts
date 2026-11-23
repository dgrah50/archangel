import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Implementer } from "../agents/implementer.js";
import { buildImplementPrompt } from "../agents/prompts.js";
import { GitBroker } from "../broker/git-broker.js";
import { LazyWorkspace } from "../compute/lazy-workspace.js";
import { LocalProvider } from "../compute/local.js";
import { GatePolicySchema, REPO_POLICY_PATH, REPO_SLUG_RE, type ArchangelConfig } from "../config.js";
import { AttemptError } from "../ledger/schema.js";
import type { Ledger } from "../ledger/store.js";
import type { OnboardRunner } from "./onboard.js";
import type { PitchItem } from "./pitch.js";
import { loadPromotablePitch, markSlices, parseSlices, sliceIssueBody } from "./pitch-promote.js";
import { scoutContentHash } from "./scout.js";
import type { WorkClass } from "./work-class.js";
import { loadRepoInstructions } from "./workflow-load.js";

/**
 * Owner-run builds: the owner's way to land a change that touches protected paths. The unattended daemon can never edit those paths,
 * so the owner runs one implementer session here, on this machine, reads the whole diff, and only then does the owner's `gh` push a
 * `selfbuild/*` branch and open the PR. Two commands use it: `archangel pitch promote --build` (one slice of a pitch) and
 * `archangel scout fix` (a Scout's bug proposal). Nothing in the daemon imports this module, the branch is never `factory/*`, and
 * nothing is merged: the owner merges the PR like any other.
 */
interface OwnerBuildDeps {
  repo: string;
  yes: boolean;
  cfg: Pick<ArchangelConfig, "implementTimeoutMs" | "setupTimeoutMs">;
  implementer: Implementer;
  confirm: (question: string) => Promise<boolean>;
  log: (s: string) => void;
  now?: number;
}

export interface SelfBuildInput extends OwnerBuildDeps {
  issue: number;
  /** One 1-based slice number. */
  slice: string;
  labels: { agentPitch: string };
}

/** What differs between the two owner-run builds: the task text (agent-written, pinned to what the Ledger recorded) and how the PR presents it. */
interface OwnerBuildTask {
  issue: number;
  branch: string;
  title: string;
  body: string;
  workClass: WorkClass;
  prTitle: string;
  /** The PR body's lead paragraphs, before the verification line and the diff stat. */
  prLead: string[];
}

/** The brief lifts the implementer prompt's protected-path rule, because this build is owner-supervised and its diff is read before anything is pushed. */
const OWNER_BUILD_NOTE = [
  "",
  "OWNER-RUN BUILD (this overrides rule 2, rule 3's size limits and rule 4 above): the repository's owner is running you locally and will read the full diff before anything is pushed.",
  "You MAY edit protected paths, and you MAY change or delete existing tests, where the task needs it. Still keep the change as small as the task allows, and do not edit lockfiles or CI workflows unless the task requires it.",
].join("\n");

/** Conventional-commit prefix of the PR, by what kind of change the pitch is. */
const PR_PREFIX: Record<PitchItem["type"], string> = { removal: "refactor", architecture: "refactor", performance: "perf", ux: "feat", feature: "feat" };

export async function selfBuild(runner: OnboardRunner, ledger: Ledger, input: SelfBuildInput): Promise<string> {
  const { pitch, promotedSoFar } = await loadPromotablePitch(runner, ledger, input);
  const [index, ...extra] = parseSlices(input.slice, pitch.slices.length);
  if (index === undefined || extra.length > 0) throw new Error("--build needs exactly one --slice");
  if (promotedSoFar.includes(index)) throw new Error(`Slice ${index + 1} of pitch #${input.issue} is already promoted`);
  const { title, body } = sliceIssueBody(input.issue, pitch, index);
  const url = await ownerBuild(runner, input, {
    issue: input.issue,
    branch: `selfbuild/${input.issue}-${index + 1}`,
    title,
    body,
    workClass: "feature",
    prTitle: `${PR_PREFIX[pitch.type]}: ${title}`,
    prLead: [
      `Built locally by \`archangel pitch promote --build\` from pitch #${input.issue} (agent-written, owner-promoted), slice ${index + 1} of ${pitch.slices.length}. The owner read the diff before it was pushed.`,
      `**Problem.** ${pitch.problem}`,
      `**This slice.** ${pitch.slices[index]!.acceptance}`,
    ],
  });
  markSlices(ledger, input.issue, [index], pitch.slices.length, input.now);
  ledger.appendAudit("pitch/self_built", input.issue, "owner", { slice: index, branch: `selfbuild/${input.issue}-${index + 1}`, pr: url }, input.now);
  const done = ledger.getPitch(input.issue)!.state.kind === "promoted";
  if (done) await runner.run("gh", ["issue", "close", String(input.issue), "--repo", input.repo, "--comment", `Built by the owner in ${url}.`]);
  else await runner.run("gh", ["issue", "comment", String(input.issue), "--repo", input.repo, "--body", `Slice ${index + 1} built by the owner in ${url}. The other slices are still open for promotion.`]);
  return url;
}

/**
 * `archangel scout fix`: build the fix for a Scout's bug proposal here. Only a proposal this Ledger recorded, still open and
 * byte-identical to what the Scout filed, is accepted: the text is agent-written, and what the owner read on GitHub must be what the implementer gets.
 */
export async function ownerFix(runner: OnboardRunner, ledger: Ledger, input: OwnerBuildDeps & { issue: number }): Promise<string> {
  if (!REPO_SLUG_RE.test(input.repo)) throw new Error(`Expected owner/name, got '${input.repo}'`);
  const proposal = ledger.getScoutProposal(input.issue);
  if (!proposal) throw new Error(`#${input.issue} is not a Scout proposal recorded by this Ledger`);
  const live = JSON.parse(await runner.run("gh", ["issue", "view", String(input.issue), "--repo", input.repo, "--json", "title,body,state"])) as { title: string; body: string; state: string };
  if (live.state.toLowerCase() !== "open") throw new Error(`Proposal #${input.issue} is not open on GitHub`);
  if (scoutContentHash(live.title, live.body) !== proposal.contentSha256) {
    throw new Error(`Proposal #${input.issue} was edited after it was filed; refusing to build text that no longer matches the Ledger`);
  }
  const branch = `selfbuild/fix-${input.issue}`;
  const url = await ownerBuild(runner, input, {
    issue: input.issue,
    branch,
    title: live.title,
    body: live.body,
    workClass: "bugfix",
    prTitle: `fix: ${live.title}`,
    prLead: [
      `Built locally by \`archangel scout fix\` from proposal #${input.issue} (written by the \`${proposal.scoutName}\` Scout). The owner read the diff before it was pushed.`,
      `Closes #${input.issue}`,
    ],
  });
  ledger.appendAudit("scout/owner_fixed", input.issue, "owner", { branch, pr: url }, input.now);
  return url;
}

/** One implementer session in a credential-free clone, the repo's own testCmd, the full diff shown, and only after a yes: the owner's `gh` pushes the branch and opens the PR. */
async function ownerBuild(runner: OnboardRunner, input: OwnerBuildDeps, task: OwnerBuildTask): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-selfbuild-"));
  try {
    // The owner's gh makes the only copy that can reach the remote; the implementer works in a credential-free clone of it.
    const bare = path.join(tmp, "bare.git");
    await runner.run("gh", ["repo", "clone", input.repo, bare, "--", "--bare"]);
    const base = (await runner.run("git", ["symbolic-ref", "--short", "HEAD"], { cwd: bare })).trim();
    const broker = new GitBroker({ bareRepoPath: bare, clonesDir: path.join(tmp, "clones"), defaultBranch: base });
    const mainSha = await broker.resolveRef("HEAD");

    const policyRaw = await broker.readFileAtRef(mainSha, REPO_POLICY_PATH);
    if (!policyRaw) throw new Error(`${input.repo} has no ${REPO_POLICY_PATH}; refusing to build without a testCmd to prove it.`);
    const gate = GatePolicySchema.parse((JSON.parse(policyRaw) as { gate?: unknown }).gate ?? {});
    if (!gate.testCmd) throw new Error(`${REPO_POLICY_PATH} has no gate.testCmd; refusing to build without a test command.`);

    const compute = new LocalProvider(broker);
    const handle = new LazyWorkspace(compute, { issueNumber: task.issue, startSha: mainSha }, async (ws) => {
      try {
        await broker.runRepoSetup(ws.path, mainSha, input.cfg.setupTimeoutMs);
      } catch (err) {
        throw new AttemptError("setup_failed", err instanceof Error ? err.message : String(err));
      }
    });
    try {
      const ws = await handle.workspace();
      const result = await input.implementer.run({
        issueNumber: task.issue,
        workspaces: { local: handle },
        prompt: buildImplementPrompt({ issueNumber: task.issue, title: task.title, body: task.body, repoName: input.repo, gate, workClass: task.workClass, repoInstructions: await loadRepoInstructions(broker, mainSha) }) + OWNER_BUILD_NOTE,
        abortController: new AbortController(),
        timeoutMs: input.cfg.implementTimeoutMs,
        role: "implement",
      });
      if (result.aborted) throw new Error("The implementer was aborted; nothing was pushed.");
      if (result.failure) throw new Error(`The implementer did not finish (${result.failure}); nothing was pushed.`);

      const headSha = await broker.stageCloneHead(ws.path, `refs/archangel/${task.branch}`, task.prTitle);
      if (headSha === mainSha) throw new Error("The implementer changed nothing; nothing was pushed.");

      // The Gate passes an owner's branch through unchecked, so what proves this build is the repo's own testCmd, run here with no credentials.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-selfbuild-home-"));
      let tests;
      try {
        tests = await compute.exec(ws, { cmd: "sh", args: ["-c", gate.testCmd], env: { PATH: process.env.PATH, HOME: home, CI: "1" }, timeoutMs: input.cfg.implementTimeoutMs });
      } finally {
        // A test run can leave background writers (Go's build cache) in its HOME: retry, and never lose a finished build to a leftover temp dir.
        try {
          fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (err) {
          input.log(`Left ${home} behind (${err instanceof Error ? err.message : String(err)}); remove it by hand.`);
        }
      }
      const testsPassed = tests.code === 0;
      const stat = await broker.diffStat(mainSha, headSha);
      const diff = await runner.run("git", ["diff", "--no-color", mainSha, headSha], { cwd: bare });
      input.log(`----- Owner build of #${task.issue}: ${task.title} -----\n${diff}\n${stat}\n\ntestCmd \`${gate.testCmd}\`: ${testsPassed ? "passed" : "FAILED"}\n`);
      if (!testsPassed) throw new Error(`testCmd (${gate.testCmd}) failed; nothing was pushed.\n${(tests.stdout + tests.stderr).trim().split("\n").slice(-20).join("\n")}`);
      if (!input.yes && !(await input.confirm(`Push ${task.branch} and open an owner-authored PR against ${base} on ${input.repo}? [y/N] `))) {
        throw new Error("Not confirmed; nothing was pushed.");
      }

      await runner.run("git", ["update-ref", `refs/heads/${task.branch}`, headSha], { cwd: bare });
      await runner.run("git", ["push", "origin", task.branch], { cwd: bare });
      const prBody = [
        "## Summary",
        "",
        ...task.prLead.flatMap((l) => [l, ""]),
        `**Verified.** \`${gate.testCmd}\` passed locally. No reviewer model read this change: the owner is its reviewer, and Archangel never merges it.`,
        "",
        "```",
        stat,
        "```",
      ].join("\n");
      return (await runner.run("gh", ["pr", "create", "--repo", input.repo, "--base", base, "--head", task.branch, "--title", task.prTitle, "--body", prBody])).trim();
    } finally {
      handle.destroy();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
