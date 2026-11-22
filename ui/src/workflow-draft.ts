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
    kind: "bug" | "pitch";
    skills: string[];
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
      kind: s.kind,
      skills: s.skills,
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

export function csrfToken(): string {
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

/** How many fields differ between the draft the editor started from and the form now (the sticky footer's "N changes"). */
export function countEdits(base: DraftForm, now: DraftForm): number {
  const flat = (f: DraftForm): Record<string, string> => {
    const { scouts, ...rest } = f;
    return {
      ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, JSON.stringify(v)])),
      ...Object.fromEntries(scouts.flatMap((s) => Object.entries(s).map(([k, v]) => [`${s.name}.${k}`, JSON.stringify(v)]))),
    };
  };
  const a = flat(base);
  const b = flat(now);
  return Object.keys(b).filter((k) => a[k] !== b[k]).length;
}

/** Skill refs a Scout names that the host's bundled list cannot resolve (`folder/*` needs at least one skill in the folder). */
export function unresolvedSkills(form: DraftForm, available: readonly string[]): string[] {
  const ok = (ref: string) => (ref.endsWith("/*") ? available.some((a) => a.startsWith(ref.slice(0, -1))) : available.includes(ref));
  return form.scouts.flatMap((s) => s.skills.filter((r) => !ok(r)).map((r) => `${s.name}: ${r}`));
}

export type ReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Never throws: a failed GET is `{ ok: false }` so the caller must render it. */
async function getJson<T>(url: string): Promise<ReadResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "X-Archangel-Token": csrfToken() } });
  } catch (e) {
    return { ok: false, error: `network error: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // reported below with the status
  }
  if (!res.ok || body === null) return { ok: false, error: (body as { error?: string } | null)?.error ?? `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
  return { ok: true, value: body as T };
}

export async function loadSkills(): Promise<ReadResult<string[]>> {
  const r = await getJson<{ skills?: unknown }>("/api/skills");
  if (!r.ok) return r;
  const skills = r.value.skills;
  return Array.isArray(skills) && skills.every((x) => typeof x === "string") ? { ok: true, value: skills as string[] } : { ok: false, error: "unexpected /api/skills reply" };
}

export interface PrStatus {
  number: number;
  state: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision: string;
  url: string;
  statusCheckRollup: Array<{ name?: string; context?: string; status?: string; conclusion?: string; state?: string }>;
}

/** The PR number from the URL `proposeWorkflow` returned; null when it does not look like a PR URL. */
export const prNumberOf = (url: string): number | null => {
  const m = /\/pull\/(\d+)\/?$/.exec(url.trim());
  return m ? Number(m[1]) : null;
};

export const loadPr = async (repo: string, n: number): Promise<ReadResult<PrStatus>> => {
  const r = await getJson<PrStatus>(`/api/gh/pr?repo=${encodeURIComponent(repo)}&number=${n}`);
  if (!r.ok) return r;
  return typeof r.value.number === "number" && typeof r.value.state === "string" && Array.isArray(r.value.statusCheckRollup) ? r : { ok: false, error: "unexpected /api/gh/pr reply" };
};

/** Passing, failing and still-running counts over gh's mixed CheckRun / StatusContext rollup. */
export function summarizeChecks(rollup: PrStatus["statusCheckRollup"]): { pass: number; fail: number; pending: number } {
  const out = { pass: 0, fail: 0, pending: 0 };
  for (const c of rollup) {
    const v = c.conclusion || c.state || "";
    if (c.status && c.status !== "COMPLETED") out.pending++;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v)) out.pass++;
    else if (v === "PENDING" || v === "EXPECTED" || v === "") out.pending++;
    else out.fail++;
  }
  return out;
}
