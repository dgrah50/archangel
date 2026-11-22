import type { Workflow } from "../../src/core/workflow.js";
import type { DiffLine } from "../../src/core/ui-propose.js";
import type { FieldChange } from "../../src/core/workflow.js";

/** Form-friendly view of an editable workflow draft. Fields the editor does not show are carried through untouched. */
export interface DraftForm {
  maxNonTestLines: number;
  maxTotalLines: number;
  maxFiles: number;
  baseTestRuns: number;
  headTestRuns: number;
  testCmd: string;
  protectedPaths: string;
  requiredChecks: string;
  rubric: string;
  landing: "owner" | "autonomous";
  scouts: Array<{
    name: string;
    schedule: "daily" | "weekly" | "manual";
    maxProposals: number;
    promotion: "owner" | "auto";
    includeMetrics: boolean;
  }>;
}

const lines = (xs: readonly string[]) => xs.join("\n");
const unlines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export function toForm(d: Workflow): DraftForm {
  return {
    maxNonTestLines: d.gate.maxNonTestLines,
    maxTotalLines: d.gate.maxTotalLines,
    maxFiles: d.gate.maxFiles,
    baseTestRuns: d.gate.baseTestRuns,
    headTestRuns: d.gate.headTestRuns,
    testCmd: d.gate.testCmd,
    protectedPaths: lines(d.gate.protectedPaths),
    requiredChecks: lines(d.requiredChecks),
    rubric: d.review.rubric ?? "",
    landing: d.landing.bugfix,
    scouts: d.scouts.map((s) => ({
      name: s.name,
      schedule: s.schedule,
      maxProposals: s.maxProposals,
      promotion: s.promotion,
      includeMetrics: s.includeMetrics,
    })),
  };
}

/** Applies the form onto the original draft (so globs, skills and other hidden fields round-trip unchanged). */
export function fromForm(form: DraftForm, original: Workflow): Workflow {
  const byName = new Map(form.scouts.map((s) => [s.name, s]));
  const { rubric: _drop, ...reviewRest } = original.review;
  return {
    ...original,
    gate: {
      ...original.gate,
      maxNonTestLines: form.maxNonTestLines,
      maxTotalLines: form.maxTotalLines,
      maxFiles: form.maxFiles,
      baseTestRuns: form.baseTestRuns,
      headTestRuns: form.headTestRuns,
      testCmd: form.testCmd,
      protectedPaths: unlines(form.protectedPaths),
    },
    requiredChecks: unlines(form.requiredChecks),
    review: form.rubric.trim() ? { ...reviewRest, rubric: form.rubric } : reviewRest,
    landing: { bugfix: form.landing },
    scouts: original.scouts.map((s) => ({ ...s, ...(byName.get(s.name) ?? {}) })),
  };
}

export interface PreviewResult {
  changes: FieldChange[];
  loosens: boolean;
  rawDiff: DiffLine[];
}

export type ProposeOutcome = { preview: PreviewResult } | { url: string } | { error: string };

function csrfToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="archangel-token"]')?.content ?? "";
}

/** The page's token is only present when the server enables proposing (never with --allow-remote). */
export function proposingEnabled(): boolean {
  return csrfToken() !== "";
}

/** Never throws: a network failure or a non-JSON reply becomes `{ error }` so the editor can show it and re-enable its buttons. */
export async function propose(repo: string, draft: Workflow, baseFileSha256: string, dryRun: boolean): Promise<ProposeOutcome> {
  let res: Response;
  try {
    res = await fetch(`/api/workflows/${encodeURIComponent(repo)}/propose`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Archangel-Token": csrfToken() },
      body: JSON.stringify({ draft, baseFileSha256, dryRun }),
    });
  } catch (e) {
    return { error: `network error: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text().catch(() => "");
  let body: Partial<{ preview: PreviewResult; url: string; error: string }> = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // not JSON: reported below with the status and the start of the body
  }
  if (!res.ok || body.error) return { error: body.error ?? `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
  if (body.preview) return { preview: body.preview };
  if (body.url) return { url: body.url };
  return { error: "unexpected response" };
}
