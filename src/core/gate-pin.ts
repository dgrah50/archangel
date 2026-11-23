import fs from "node:fs";
import { REPO_SLUG_RE } from "../config.js";
import path from "node:path";
import { ARCHANGEL_ROOT, createOrResetBranch, GATE_WORKFLOW_PATH, exitedOne, pinnedSha, withBranch, type OnboardRunner } from "./onboard.js";
import { readRepoFile } from "./workflow-propose.js";

export const BUMP_BRANCH = "chore/archangel-gate-bump";

const PIN_LINE = /^(\s*ARCHANGEL_GATE_SHA:)[ \t]*(\S*)[ \t]*$/m;

export function pinOf(workflow: string): string | null {
  const m = PIN_LINE.exec(workflow);
  return m && m[2] ? m[2] : null;
}

export function withPin(workflow: string, sha: string): string {
  return workflow.replace(PIN_LINE, `$1 ${sha}`);
}

export function canonicalTemplate(root: string = ARCHANGEL_ROOT): string {
  return fs.readFileSync(path.join(root, "workflows/archangel-gate.yml"), "utf8");
}

const BUNDLE_PATH = "bin/archangel-gate.mjs";

/** Blob id of the built Gate bundle at `ref`: the Gate itself, so config-schema churn the bundle never notices is not drift. */
export async function gateBundleId(runner: OnboardRunner, ref: string = "HEAD", root: string = ARCHANGEL_ROOT): Promise<string> {
  return (await runner.run("git", ["rev-parse", `${ref}:${BUNDLE_PATH}`], { cwd: root })).trim();
}

export interface PinDrift {
  /** The pin or workflow is broken: missing, unknown, divergent, or the workflow differs from the template. */
  drifted: boolean;
  reasons: string[];
  /** The pinned Gate bundle differs from the current one. Informational: an older Gate is safe, it runs the older checks. */
  newerBundle: boolean;
}

/** Pure-ish: git reads only. */
export async function assessPinDrift(
  runner: OnboardRunner,
  workflow: string,
  opts: { root?: string; template?: string; branch?: string } = {},
): Promise<PinDrift> {
  const root = opts.root ?? ARCHANGEL_ROOT;
  const base = opts.template ?? canonicalTemplate(root);
  // The template is written with the repo's own default branch, so that is what the workflow must be compared against.
  const template = opts.branch ? withBranch(base, opts.branch) : base;
  const reasons: string[] = [];
  let newerBundle = false;
  const pin = pinOf(workflow);
  if (!pin) {
    reasons.push("workflow has no ARCHANGEL_GATE_SHA pin");
  } else {
    let known = true;
    try {
      await runner.run("git", ["rev-parse", "--verify", "--quiet", `${pin}^{commit}`], { cwd: root });
    } catch (err) {
      if (!exitedOne(err)) throw err;
      known = false;
    }
    if (!known) {
      reasons.push(`pin ${pin.slice(0, 10)} is not in the local Archangel checkout`);
    } else {
      // A pin on a divergent (unmerged) line is unreviewed gate code, not merely older.
      let onMain = true;
      try {
        await runner.run("git", ["merge-base", "--is-ancestor", pin, "HEAD"], { cwd: root });
      } catch (err) {
        if (!exitedOne(err)) throw err;
        onMain = false;
        reasons.push(`pin ${pin.slice(0, 10)} is not an ancestor of the current Archangel HEAD (divergent history)`);
      }
      if (onMain) newerBundle = (await gateBundleId(runner, pin, root)) !== (await gateBundleId(runner, "HEAD", root));
    }
  }
  if (withPin(workflow, "PIN") !== withPin(template, "PIN")) {
    reasons.push("workflow differs from the canonical template (ignoring the pin)");
  }
  return { drifted: reasons.length > 0, reasons, newerBundle };
}

async function readWorkflow(runner: OnboardRunner, repo: string, ref: string): Promise<{ content: string; blobSha: string } | null> {
  return readRepoFile(runner, repo, ref, GATE_WORKFLOW_PATH);
}

/**
 * Opens one PR per drifted repo with the owner's `gh`: the canonical template, pinned to Archangel HEAD.
 * Never merges. Skips repos with no workflow, no drift, or an open bump PR.
 */
export async function gateBump(
  runner: OnboardRunner,
  repos: string[],
  opts: { dryRun?: boolean; log?: (s: string) => void; root?: string } = {},
): Promise<Record<string, "bumped" | "would-bump" | "current" | "no-workflow" | "pr-open">> {
  const log = opts.log ?? console.log;
  const root = opts.root ?? ARCHANGEL_ROOT;
  for (const r of repos) if (!REPO_SLUG_RE.test(r)) throw new Error(`Expected owner/name, got '${r}'`);
  const head = await pinnedSha(runner, root, "bump the Gate pin");
  const pinned = withPin(canonicalTemplate(root), head);
  const out: Record<string, "bumped" | "would-bump" | "current" | "no-workflow" | "pr-open"> = {};

  for (const repo of repos) {
    const branch = (await runner.run("gh", ["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).trim();
    const wf = await readWorkflow(runner, repo, branch);
    if (!wf) {
      log(`${repo}: no ${GATE_WORKFLOW_PATH} on ${branch} (use \`archangel onboard\`)`);
      out[repo] = "no-workflow";
      continue;
    }
    const drift = await assessPinDrift(runner, wf.content, { root, branch });
    if (!drift.drifted && !drift.newerBundle) {
      log(`${repo}: Gate pin is current`);
      out[repo] = "current";
      continue;
    }
    if (drift.newerBundle) drift.reasons.push("pinned Gate bundle differs from the current one");
    log(`${repo}: drift (${drift.reasons.join("; ")})`);
    const open = (
      await runner.run("gh", ["pr", "list", "--repo", repo, "--head", BUMP_BRANCH, "--state", "open", "--json", "url", "-q", ".[0].url"])
    ).trim();
    if (open) {
      log(`${repo}: bump PR already open: ${open}`);
      out[repo] = "pr-open";
      continue;
    }
    if (opts.dryRun) {
      log(`${repo}: would open a PR pinning ${head.slice(0, 10)} (dry run)`);
      out[repo] = "would-bump";
      continue;
    }
    const baseSha = (await runner.run("gh", ["api", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"])).trim();
    await createOrResetBranch(runner, repo, BUMP_BRANCH, baseSha);
    await runner.run("gh", [
      "api", "-X", "PUT", `repos/${repo}/contents/${GATE_WORKFLOW_PATH}`,
      "-f", `message=chore: pin Archangel Gate to ${head.slice(0, 10)}`,
      "-f", `content=${Buffer.from(withBranch(pinned, branch)).toString("base64")}`,
      "-f", `sha=${wf.blobSha}`,
      "-f", `branch=${BUMP_BRANCH}`,
    ]);
    const url = (
      await runner.run("gh", [
        "pr", "create", "--repo", repo, "--head", BUMP_BRANCH, "--base", branch,
        "--title", `chore: pin Archangel Gate to ${head.slice(0, 10)}`,
        "--body", `Re-pins ARCHANGEL_GATE_SHA to ${head} and syncs the Gate workflow to the canonical template.\n\nDrift: ${drift.reasons.join("; ")}.\nReview and merge manually; nothing here merges itself.`,
      ])
    ).trim();
    log(`${repo}: opened ${url}`);
    out[repo] = "bumped";
  }
  return out;
}

