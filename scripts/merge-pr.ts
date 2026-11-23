/**
 * Merges one PR under main's ruleset (branch must be up to date, no auto-merge, never --admin):
 * update the branch if it is behind, wait for checks, refuse out-of-scope deletions, squash-merge
 * pinned to the head that passed, and go round again if main moved meanwhile.
 *
 *   bun scripts/merge-pr.ts <pr> [--repo owner/name] [--require Test,Gate] [--allow-deletions]
 *
 * --allow-deletions: the PR is meant to delete code (a prune or a removal); skip the deletion guard.
 */
import { $ } from "bun";

const args = process.argv.slice(2);
const pr = args.find((a) => /^\d+$/.test(a));
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!pr) {
  console.error("usage: bun scripts/merge-pr.ts <pr> [--repo owner/name] [--require Test,Gate] [--allow-deletions]");
  process.exit(2);
}
const repo = flag("--repo") ?? "dgrah50/archangel";
const required = (flag("--require") ?? (repo === "dgrah50/archangel" ? "Test,Gate" : "")).split(",").filter(Boolean);
const allowDeletions = args.includes("--allow-deletions");

/** A file that loses this many more lines than it gains is the shape of a stale-copy revert (#178 undid #167). */
const DELETION_GUARD = 40;
const MAX_ROUNDS = 6;

interface PrView {
  state: string;
  headRefOid: string;
  mergeStateStatus: string;
  files: Array<{ path: string; additions: number; deletions: number }>;
}

async function view(): Promise<PrView> {
  return JSON.parse(await $`gh pr view ${pr} --repo ${repo} --json state,headRefOid,mergeStateStatus,files`.text());
}

function fail(msg: string): never {
  console.error(`merge-pr #${pr}: ${msg}`);
  process.exit(1);
}

/** Waits until every check on the current head finishes; returns the final check list. */
async function waitForChecks(): Promise<Array<{ name: string; state: string }>> {
  for (let i = 0; i < 20; i++) {
    // `--watch` exits 1 both on a failed check and on "no checks reported" (CI not attached yet), so judge by the JSON after.
    await $`gh pr checks ${pr} --repo ${repo} --watch --interval 15`.quiet().nothrow();
    const checks: Array<{ name: string; state: string }> = JSON.parse(
      (await $`gh pr checks ${pr} --repo ${repo} --json name,state`.quiet().nothrow()).stdout.toString() || "[]",
    );
    const pending = checks.some((c) => ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"].includes(c.state));
    const missing = required.filter((n) => !checks.some((c) => c.name === n));
    if (!pending && missing.length === 0) return checks;
    if (missing.length > 0 && i === 3) {
      // CI sometimes never starts on a push (only GitGuardian reports); updating the branch kicks it.
      console.log(`required checks ${missing.join(", ")} not reported; updating the branch to start CI`);
      await $`gh pr update-branch ${pr} --repo ${repo}`.quiet().nothrow();
    }
    await Bun.sleep(15_000);
  }
  fail(`required checks ${required.join(", ")} never reported`);
}

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const v = await view();
  if (v.state === "MERGED") {
    console.log(`#${pr} is already merged`);
    process.exit(0);
  }
  if (v.state !== "OPEN") fail(`PR is ${v.state}`);
  if (v.mergeStateStatus === "DIRTY") fail("merge conflict with main: rebase it in its worktree first");

  if (!allowDeletions) {
    const shrinking = v.files.filter((f) => f.deletions - f.additions >= DELETION_GUARD);
    if (shrinking.length > 0) {
      fail(
        `files lose far more than they gain; confirm each is in scope (a stale copy reverts others' work), then rerun with --allow-deletions:\n` +
          shrinking.map((f) => `  ${f.path}  +${f.additions} -${f.deletions}`).join("\n"),
      );
    }
  }

  if (v.mergeStateStatus === "BEHIND") {
    console.log(`round ${round}: branch is behind main, updating`);
    await $`gh pr update-branch ${pr} --repo ${repo}`.quiet();
    await Bun.sleep(5_000);
    continue;
  }

  const checks = await waitForChecks();
  const bad = checks.filter((c) => !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.state));
  if (bad.length > 0) fail(`checks not green:\n${bad.map((c) => `  ${c.name}: ${c.state}`).join("\n")}`);

  const head = (await view()).headRefOid;
  if (head !== v.headRefOid) continue; // a push landed while checks ran; judge the new head

  const merge = await $`gh pr merge ${pr} --repo ${repo} --squash --delete-branch --match-head-commit ${head}`.quiet().nothrow();
  if (merge.exitCode === 0) {
    console.log(`merged #${pr} at ${head.slice(0, 7)}`);
    process.exit(0);
  }
  console.log(`round ${round}: merge refused (${merge.stderr.toString().trim().split("\n")[0]}); retrying`);
}
fail(`main kept moving; gave up after ${MAX_ROUNDS} rounds`);
