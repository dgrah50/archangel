import fs from "node:fs";
import { REPO_SLUG_RE } from "../config.js";
import path from "node:path";
import { ARCHANGEL_ROOT, createOrResetBranch, GATE_WORKFLOW_PATH, exitedOne, pinnedSha, type OnboardRunner } from "./onboard.js";
import { readRepoFile } from "./workflow-propose.js";

/** Paths whose changes require every watched repo to re-pin the Gate (the pinned bundle and its workflow). */
export const GATE_RELEVANT_PATHS = ["src/gate", "src/core/workflow.ts", "src/core/work-class.ts", "src/core/skills.ts", "src/config.ts", "bin/archangel-gate.mjs", "workflows/archangel-gate.yml"];
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

/** Latest Archangel commit (local checkout) that touched anything the pinned Gate depends on. */
export async function latestGateCommit(runner: OnboardRunner, root: string = ARCHANGEL_ROOT): Promise<string> {
  const sha = (await runner.run("git", ["log", "-1", "--format=%H", "--", ...GATE_RELEVANT_PATHS], { cwd: root })).trim();
  if (!sha) throw new Error("No gate-relevant commit found in the Archangel checkout (shallow clone?)");
  return sha;
}

export interface PinDrift {
  drifted: boolean;
  reasons: string[];
}

/** Pure-ish: git reads only. A repo drifts when its pin is older than `latest` or its workflow differs from the template. */
export async function assessPinDrift(
  runner: OnboardRunner,
  workflow: string,
  latest: string,
  opts: { root?: string; template?: string } = {},
): Promise<PinDrift> {
  const root = opts.root ?? ARCHANGEL_ROOT;
  const template = opts.template ?? canonicalTemplate(root);
  const reasons: string[] = [];
  const pin = pinOf(workflow);
  if (!pin) {
    reasons.push("workflow has no ARCHANGEL_GATE_SHA pin");
  } else if (pin !== latest) {
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
      try {
        await runner.run("git", ["merge-base", "--is-ancestor", pin, latest], { cwd: root });
        reasons.push(`pin ${pin.slice(0, 10)} is older than the latest gate-relevant commit ${latest.slice(0, 10)}`);
      } catch (err) {
        if (!exitedOne(err)) throw err;
        // Not older than latest. It must also descend from latest: a pin on a divergent (unmerged) line
        // is unreviewed gate code, not "newer".
        try {
          await runner.run("git", ["merge-base", "--is-ancestor", latest, pin], { cwd: root });
        } catch (err2) {
          if (!exitedOne(err2)) throw err2;
          reasons.push(`pin ${pin.slice(0, 10)} is not a descendant of the latest gate-relevant commit ${latest.slice(0, 10)} (divergent history)`);
        }
      }
    }
  }
  if (withPin(workflow, "PIN") !== withPin(template, "PIN")) {
    reasons.push("workflow differs from the canonical template (ignoring the pin)");
  }
  return { drifted: reasons.length > 0, reasons };
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
  const latest = await latestGateCommit(runner, root);
  const template = withPin(canonicalTemplate(root), head);
  const out: Record<string, "bumped" | "would-bump" | "current" | "no-workflow" | "pr-open"> = {};

  for (const repo of repos) {
    const branch = (await runner.run("gh", ["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).trim();
    const wf = await readWorkflow(runner, repo, branch);
    if (!wf) {
      log(`${repo}: no ${GATE_WORKFLOW_PATH} on ${branch} (use \`archangel onboard\`)`);
      out[repo] = "no-workflow";
      continue;
    }
    const drift = await assessPinDrift(runner, wf.content, latest, { root });
    if (!drift.drifted) {
      log(`${repo}: Gate pin is current`);
      out[repo] = "current";
      continue;
    }
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
      "-f", `content=${Buffer.from(template).toString("base64")}`,
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

