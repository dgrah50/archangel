import { REPO_SLUG_RE, type LabelsSchema } from "../config.js";
import type { Ledger } from "../ledger/store.js";
import type { OnboardRunner } from "./onboard.js";
import { PitchOutputSchema, type PitchItem } from "./pitch.js";
import { isUndecided, promotedSlicesOf } from "./pitch-machine.js";
import { scoutContentHash } from "./scout.js";
import type { z } from "zod";

type Labels = z.infer<typeof LabelsSchema>;

/**
 * `archangel pitch promote`: the only way a pitch becomes work. It runs with the OWNER's `gh`, so the new issues and their
 * labels are authored by the owner, which turns model-written text into an owner-authored issue. That is why every body is
 * printed in full and needs an explicit confirmation (or `--yes`).
 */
export function sliceIssueBody(pitchIssue: number, pitch: PitchItem, sliceIndex: number): { title: string; body: string } {
  const s = pitch.slices[sliceIndex]!;
  return {
    title: s.title,
    body: [
      `Derived from pitch #${pitchIssue} (agent-written; owner-promoted).`,
      "",
      "## What to build",
      s.acceptance,
      "",
      "## Context from the pitch",
      `**Problem:** ${pitch.problem}`,
      "",
      `**Proposal:** ${pitch.proposal}`,
      "",
      `**Smallest version:** ${pitch.smallestVersion}`,
      "",
      "This is a feature: no reproduction test is needed. Add a test only if it locks down behaviour someone relies on.",
    ].join("\n"),
  };
}

/** `--slice 1,3` to zero-based indexes in ascending order; every entry must be an integer in range, with no repeats. */
function parseSlices(arg: string, total: number): number[] {
  const nums = arg.split(",").map((part) => (/^\s*\d+\s*$/.test(part) ? Number(part) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > total)) throw new Error(`--slice must be one or more whole numbers between 1 and ${total}, comma-separated (got '${arg}')`);
  if (new Set(nums).size !== nums.length) throw new Error(`--slice lists a slice more than once (got '${arg}')`);
  return nums.map((n) => n - 1).sort((a, b) => a - b);
}

export async function promotePitch(
  runner: OnboardRunner,
  ledger: Ledger,
  input: {
    repo: string;
    issue: number;
    /** 1-based slice numbers as typed: one (`2`) or a comma list (`1,3`). Default: every slice not yet promoted. */
    slice?: string;
    /** Make the slices created by this call linear: each waits (queued) for the one before it to merge. */
    chain?: boolean;
    yes: boolean;
    labels: Pick<Labels, "readyForAgent" | "feature" | "agentPitch">;
    confirm: (question: string) => Promise<boolean>;
    log: (s: string) => void;
    now?: number;
  },
): Promise<number[]> {
  if (!REPO_SLUG_RE.test(input.repo)) throw new Error(`Expected owner/name, got '${input.repo}'`);
  const row = ledger.getPitch(input.issue);
  if (!row) throw new Error(`#${input.issue} is not a pitch recorded by this Ledger`);
  // A pitch with some slices promoted is still undecided: its remaining slices can be promoted later.
  if (!isUndecided(row.state)) throw new Error(`Pitch #${input.issue} is already ${row.state.kind}`);
  const promotedSoFar = promotedSlicesOf(row.state);

  // The pitch the owner reads on GitHub must be exactly what was filed: re-check the pinned content hash first.
  const live = JSON.parse(await runner.run("gh", ["issue", "view", String(input.issue), "--repo", input.repo, "--json", "title,body,state,labels"])) as {
    title: string;
    body: string;
    state: string;
    labels: Array<{ name: string }>;
  };
  if (live.state.toLowerCase() !== "open") throw new Error(`Pitch #${input.issue} is not open on GitHub`);
  if (!live.labels.some((l) => l.name === input.labels.agentPitch)) throw new Error(`#${input.issue} does not carry the ${input.labels.agentPitch} label`);
  if (scoutContentHash(live.title, live.body) !== row.contentSha256) {
    throw new Error(`Pitch #${input.issue} was edited after it was filed; refusing to promote text that no longer matches the Ledger`);
  }

  const pitch = PitchOutputSchema.shape.pitches.element.parse(JSON.parse(row.pitchJson));
  const remaining = pitch.slices.map((_, i) => i).filter((i) => !promotedSoFar.includes(i));
  const indexes = input.slice === undefined ? remaining : parseSlices(input.slice, pitch.slices.length);
  const again = indexes.filter((i) => promotedSoFar.includes(i));
  if (again.length > 0) throw new Error(`Slice ${again.map((i) => i + 1).join(", ")} of pitch #${input.issue} is already promoted`);
  if (indexes.length === 0) throw new Error(`Every slice of pitch #${input.issue} is already promoted`);
  const drafts = indexes.map((i) => sliceIssueBody(input.issue, pitch, i));

  for (const [n, d] of drafts.entries()) {
    input.log(`----- Issue ${n + 1}/${drafts.length}: ${d.title} -----\n${d.body}\n`);
  }
  if (!input.yes && !(await input.confirm(`Open ${drafts.length} owner-authored issue(s) labelled ${input.labels.readyForAgent} and ${input.labels.feature}? [y/N] `))) {
    throw new Error("Not confirmed; nothing was created.");
  }

  const created: number[] = [];
  try {
    for (const d of drafts) {
      const url = (
        await runner.run("gh", [
          "issue", "create", "--repo", input.repo, "--title", d.title, "--body", d.body,
          // Chained slices get ready-for-agent only after their order is recorded, so the daemon cannot start one early.
          ...(input.chain ? [] : ["--label", input.labels.readyForAgent]), "--label", input.labels.feature,
        ])
      ).trim();
      const m = /\/issues\/(\d+)\s*$/.exec(url);
      if (!m) throw new Error(`Could not read the new issue number from: ${url}`);
      created.push(Number(m[1]));
      input.log(`Opened ${url}`);
    }
  } catch (err) {
    if (created.length === 0) throw err;
    // Some owner-authored issues already exist. Mark the pitch decided so a rerun cannot duplicate them, and say what is left.
    // Record first: chaining runs gh again and may itself fail, which must not skip the record (a rerun would duplicate issues).
    markSlices(ledger, input.issue, indexes.slice(0, created.length), pitch.slices.length, input.now);
    ledger.appendAudit("pitch/promoted", input.issue, "owner", { features: created, slices: indexes.slice(0, created.length), partial: true }, input.now);
    let chainNote = "";
    try {
      await chainSlices(runner, ledger, input, created);
    } catch (chainErr) {
      chainNote = ` Chaining the created issues also failed (${chainErr instanceof Error ? chainErr.message : String(chainErr)}); add ${input.labels.readyForAgent} to them yourself.`;
    }
    throw new Error(
      `Created ${created.map((n) => `#${n}`).join(", ")} but then failed (${err instanceof Error ? err.message : String(err)}). Those slices are marked promoted and the pitch is left open; rerun to promote the remaining slices.${chainNote}`,
    );
  }
  await chainSlices(runner, ledger, input, created);
  markSlices(ledger, input.issue, indexes, pitch.slices.length, input.now);
  ledger.appendAudit("pitch/promoted", input.issue, "owner", { features: created, slices: indexes, chained: Boolean(input.chain) }, input.now);
  const done = ledger.getPitch(input.issue)!.state.kind === "promoted";
  const list = created.map((n) => `#${n}`).join(", ");
  if (done) {
    await runner.run("gh", ["issue", "close", String(input.issue), "--repo", input.repo, "--comment", `Promoted by the owner to ${list}.`]);
  } else {
    // Leave the pitch open so its remaining slices can still be promoted.
    await runner.run("gh", ["issue", "comment", String(input.issue), "--repo", input.repo, "--body", `Slice ${indexes.map((i) => i + 1).join(", ")} promoted by the owner to ${list}. The other slices are still open for promotion.`]);
  }
  return created;
}

/**
 * Slice N waits for slice N-1 (in the order they were created). The order is recorded in the Ledger the daemon reads first, and only then
 * do the slices get `ready-for-agent` (applied with the owner's `gh`, so the owner is still the label actor).
 */
async function chainSlices(
  runner: OnboardRunner,
  ledger: Ledger,
  input: { repo: string; chain?: boolean; labels: { readyForAgent: string }; now?: number },
  created: number[],
): Promise<void> {
  if (!input.chain) return;
  for (let i = 1; i < created.length; i++) ledger.addThreadDependency(created[i]!, created[i - 1]!, input.now);
  for (const n of created) {
    await runner.run("gh", ["issue", "edit", String(n), "--repo", input.repo, "--add-label", input.labels.readyForAgent]);
  }
}

/** The state machine is the authority: a refusal here means the pitch moved under us, and the issues already created must be reported. */
function markSlices(ledger: Ledger, issue: number, slices: number[], total: number, now?: number): void {
  if (!ledger.markPitchSlicesPromoted(issue, slices, total, now)) {
    throw new Error(`Pitch #${issue} could not record slices ${slices.map((i) => i + 1).join(", ")} (see the pitch/illegal_transition audit row); the issues already opened are listed above.`);
  }
}
