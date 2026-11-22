import { REPO_SLUG_RE, type LabelsSchema } from "../config.js";
import type { Ledger } from "../ledger/store.js";
import type { OnboardRunner } from "./onboard.js";
import { PitchOutputSchema, type PitchItem } from "./pitch.js";
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
      "Add tests for the new behaviour (this is a feature: no reproduction test is needed).",
    ].join("\n"),
  };
}

export async function promotePitch(
  runner: OnboardRunner,
  ledger: Ledger,
  input: {
    repo: string;
    issue: number;
    slice?: number; // 1-based
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
  // `promoted` is allowed: a pitch with some slices promoted can still have its remaining slices promoted later.
  if (row.status !== "open" && row.status !== "promoted") throw new Error(`Pitch #${input.issue} is already ${row.status}`);

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
  const remaining = pitch.slices.map((_, i) => i).filter((i) => !row.promotedSlices.includes(i));
  const indexes = input.slice === undefined ? remaining : [input.slice - 1];
  if (indexes.some((i) => i < 0 || i >= pitch.slices.length)) throw new Error(`--slice must be between 1 and ${pitch.slices.length}`);
  const again = indexes.filter((i) => row.promotedSlices.includes(i));
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
    await chainSlices(runner, ledger, input, created);
    ledger.markPitchSlicesPromoted(input.issue, indexes.slice(0, created.length), input.now);
    ledger.appendAudit("pitch/promoted", input.issue, "owner", { features: created, slices: indexes.slice(0, created.length), partial: true }, input.now);
    throw new Error(
      `Created ${created.map((n) => `#${n}`).join(", ")} but then failed (${err instanceof Error ? err.message : String(err)}). Those slices are marked promoted and the pitch is left open; rerun to promote the remaining slices.`,
    );
  }
  await chainSlices(runner, ledger, input, created);
  ledger.markPitchSlicesPromoted(input.issue, indexes, input.now);
  ledger.appendAudit("pitch/promoted", input.issue, "owner", { features: created, slices: indexes, chained: Boolean(input.chain) }, input.now);
  const done = ledger.getPitch(input.issue)!.promotedSlices.length === pitch.slices.length;
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
