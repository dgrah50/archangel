import type { Ledger } from "../ledger/store.js";
import type { OnboardRunner } from "./onboard.js";
import {
  Workflow,
  classifyChange,
  loosens,
  type EffectiveWorkflow,
  type FieldChange,
  type OkWorkflow,
} from "./workflow.js";
import { proposeWorkflow } from "./workflow-propose.js";

/**
 * The dashboard's one write path. Pure helpers plus `handlePropose`, which the UI server calls after its
 * token / Origin / Content-Type guards. It only ever opens an unmerged PR through `proposeWorkflow()`.
 */

/** The repo's current workflow as an editable version 1 draft, rebuilt from the cached resolution (no Scout prompts). */
export function draftFromEffective(wf: OkWorkflow): Workflow {
  const g = wf.gate;
  const raw = {
    version: 1,
    gate: {
      maxNonTestLines: g.maxNonTestLines,
      maxTotalLines: g.maxTotalLines,
      maxFiles: g.maxFiles,
      baseTestRuns: g.baseTestRuns,
      headTestRuns: g.headTestRuns,
      testFileGlobs: g.testFileGlobs,
      testDataGlobs: g.testDataGlobs,
      testCmd: g.testCmd,
      baseTestCmd: g.baseTestCmd,
      testBuildCmd: g.testBuildCmd,
      junitReport: g.junitReport,
      protectedPaths: g.extraProtectedPaths,
    },
    requiredChecks: wf.requiredChecks,
    review: wf.rubric === undefined ? {} : { rubric: wf.rubric },
    landing: { bugfix: wf.landingBugfix.declared ?? wf.landingBugfix.value },
    fleetScouts: { optOut: wf.fleetOptOut },
    scouts: wf.scouts.filter((s) => !s.fleet).map((s) => ({
      name: s.name,
      kind: s.kind,
      schedule: s.schedule,
      maxProposals: s.maxProposals,
      skills: s.skills,
      includeMetrics: s.includeMetrics,
      promotion: s.promotion,
    })),
  };
  return Workflow.parse(JSON.parse(JSON.stringify(raw)));
}

export interface DiffLine {
  op: " " | "-" | "+";
  text: string;
}

/** Line diff (LCS) trimmed to changed lines plus two lines of context. Workflow files are small. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  const dp: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const all: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) all.push({ op: " ", text: x[i++]! }), j++;
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) all.push({ op: "-", text: x[i++]! });
    else all.push({ op: "+", text: y[j++]! });
  }
  while (i < x.length) all.push({ op: "-", text: x[i++]! });
  while (j < y.length) all.push({ op: "+", text: y[j++]! });
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((l, k) => {
    if (l.op === " ") return;
    for (let d = -2; d <= 2; d++) if (all[k + d]) keep[k + d] = true;
  });
  return all.filter((_, k) => keep[k]);
}

const ORDER = { loosen: 0, tighten: 1, changed: 2 } as const;
export const sortChanges = (cs: FieldChange[]): FieldChange[] =>
  [...cs].sort((a, b) => ORDER[a.direction] - ORDER[b.direction] || a.field.localeCompare(b.field));

export interface DraftPreview {
  changes: FieldChange[];
  loosens: boolean;
  rawDiff: DiffLine[];
}

export class ProposeRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reads the cached workflow for `repo`; the UI cannot propose for a repo the daemon has no valid workflow for. */
function cachedOk(ledger: Ledger, repo: string): OkWorkflow {
  const hit = ledger.listCachedWorkflows().find((c) => c.repo === repo);
  if (!hit) throw new ProposeRefusal(404, `Unknown repo ${repo}`);
  const wf = hit.workflow as EffectiveWorkflow | null;
  if (!wf || typeof wf !== "object") throw new ProposeRefusal(409, `The cached workflow for ${repo} is unreadable; wait for the daemon's next tick`);
  if (wf.status !== "ok") throw new ProposeRefusal(409, `${repo} has no valid workflow (${wf.status}); fix the file by hand first`);
  return wf;
}

function parseDraft(draft: unknown): Workflow {
  const parsed = Workflow.safeParse(draft);
  if (!parsed.success) {
    throw new ProposeRefusal(400, `Invalid draft: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** Preview: classification and raw diff against the cached workflow. Reads the Ledger only; no runner, no network. */
export function previewDraft(ledger: Ledger, repo: string, draft: unknown, baseFileSha256: string): DraftPreview {
  const cached = cachedOk(ledger, repo);
  if (cached.fileSha256 !== baseFileSha256) {
    throw new ProposeRefusal(409, `Stale draft: the workflow file changed since this draft was based on it (now ${cached.fileSha256.slice(0, 12)}). Reload the page.`);
  }
  const next = parseDraft(draft);
  const prev = draftFromEffective(cached);
  const changes = sortChanges(classifyChange(prev, next));
  return {
    changes,
    loosens: loosens(changes),
    rawDiff: lineDiff(JSON.stringify(prev, null, 2), JSON.stringify(next, null, 2)),
  };
}

export interface ProposeRequest {
  draft: unknown;
  baseFileSha256: string;
  dryRun: boolean;
}

/** Validates the request body shape; the draft itself is validated by the schema. */
export function parseProposeRequest(body: unknown): ProposeRequest {
  const b = body as Partial<ProposeRequest> | null;
  if (!b || typeof b !== "object" || typeof b.baseFileSha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.baseFileSha256) || typeof b.dryRun !== "boolean" || b.draft === undefined) {
    throw new ProposeRefusal(400, "Body must be {draft, baseFileSha256 (64 hex), dryRun (boolean)}");
  }
  return { draft: b.draft, baseFileSha256: b.baseFileSha256, dryRun: b.dryRun };
}

/**
 * Preview (`dryRun`) never touches the runner. Otherwise opens one PR through `proposeWorkflow()` with the owner's
 * `gh`, refusing a stale base. Scout prompts come from the daemon's cached resolution, never from the browser.
 */
export async function handlePropose(
  ledger: Ledger,
  runner: OnboardRunner,
  repo: string,
  body: unknown,
): Promise<{ preview: DraftPreview } | { url: string }> {
  const req = parseProposeRequest(body);
  const preview = previewDraft(ledger, repo, req.draft, req.baseFileSha256);
  if (req.dryRun) return { preview };
  const cached = cachedOk(ledger, repo);
  const scoutPrompts = Object.fromEntries(cached.scouts.map((s) => [s.name, s.prompt]));
  try {
    const { url } = await proposeWorkflow(runner, repo, JSON.stringify(parseDraft(req.draft)), {
      baseFileSha256: req.baseFileSha256,
      scoutPrompts,
      log: () => undefined,
    });
    if (!url) throw new Error("no PR URL returned");
    return { url };
  } catch (err) {
    throw new ProposeRefusal(409, err instanceof Error ? err.message : String(err));
  }
}
