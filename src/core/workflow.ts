import crypto from "node:crypto";
import { z } from "zod";
import { GatePolicySchema, type GatePolicy } from "../config.js";
import { UNIVERSAL_PROTECTED_EXACT, UNIVERSAL_PROTECTED_PREFIXES } from "../gate/gate.js";
import { SKILL_REF_RE } from "./skills.js";
import type { WorkClass } from "./work-class.js";

/**
 * Pure V4 workflow core: KERNEL (invariants and maxima), the repo file schema, the resolver and the
 * tighten/loosen classifier. Nothing here does I/O, so it can ship in the pinned Gate bundle.
 */

const GATE_DEFAULTS = GatePolicySchema.parse({});

/**
 * Invariants no config can express. Numbers are today's GatePolicySchema defaults (which the CI Gate already
 * enforces as ceilings/floors via mergeRepoPolicy); the protected paths are the Gate's own constants.
 * `maxScouts` and the Scout bounds mirror the existing Scout frontmatter limits (maxProposals 3, skills 12).
 */
export const KERNEL = {
  maxNonTestLines: GATE_DEFAULTS.maxNonTestLines,
  maxTotalLines: GATE_DEFAULTS.maxTotalLines,
  maxFiles: GATE_DEFAULTS.maxFiles,
  minBaseTestRuns: GATE_DEFAULTS.baseTestRuns,
  minHeadTestRuns: GATE_DEFAULTS.headTestRuns,
  universalProtectedPrefixes: UNIVERSAL_PROTECTED_PREFIXES,
  universalProtectedExact: [...UNIVERSAL_PROTECTED_EXACT],
  implicitRequiredCheck: "Gate",
  reviewQuorum: 2,
  maxScouts: 5,
} as const;

const Glob = z.string().min(1).max(200);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/);

export const ScoutSpec = z
  .object({
    name: Slug,
    schedule: z.enum(["daily", "manual"]).default("manual"),
    maxProposals: z.number().int().min(1).max(3).default(2),
    skills: z.array(z.string().regex(SKILL_REF_RE)).max(12).default([]),
    includeMetrics: z.boolean().default(false),
    promotion: z.enum(["owner", "auto"]).default("owner"),
  })
  .strict();
export type ScoutSpec = z.infer<typeof ScoutSpec>;

export const WorkflowV2 = z
  .object({
    version: z.literal(2),
    gate: z
      .object({
        maxNonTestLines: z.number().int().min(1).max(KERNEL.maxNonTestLines).default(KERNEL.maxNonTestLines),
        maxTotalLines: z.number().int().min(1).max(KERNEL.maxTotalLines).default(KERNEL.maxTotalLines),
        maxFiles: z.number().int().min(1).max(KERNEL.maxFiles).default(KERNEL.maxFiles),
        baseTestRuns: z.number().int().min(KERNEL.minBaseTestRuns).max(10).default(KERNEL.minBaseTestRuns),
        headTestRuns: z.number().int().min(KERNEL.minHeadTestRuns).max(10).default(KERNEL.minHeadTestRuns),
        testFileGlobs: z.array(Glob).min(1),
        testDataGlobs: z.array(Glob).default([]),
        testCmd: z.string().min(1),
        baseTestCmd: z.string().min(1).optional(),
        testBuildCmd: z.string().min(1).optional(),
        protectedPaths: z.array(Glob).default([]),
      })
      .strict(),
    requiredChecks: z.array(z.string().min(1)).default([]),
    review: z.object({ rubric: z.string().max(4000).optional() }).strict().default({}),
    landing: z.object({ bugfix: z.enum(["owner", "autonomous"]).default("owner") }).strict().default({ bugfix: "owner" }),
    scouts: z.array(ScoutSpec).max(KERNEL.maxScouts).default([]),
  })
  .strict()
  .superRefine((wf, ctx) => {
    if (wf.gate.maxTotalLines < wf.gate.maxNonTestLines) {
      ctx.addIssue({ code: "custom", path: ["gate", "maxTotalLines"], message: "maxTotalLines must be >= maxNonTestLines" });
    }
    const seen = new Set<string>();
    wf.scouts.forEach((s, i) => {
      if (seen.has(s.name)) ctx.addIssue({ code: "custom", path: ["scouts", i, "name"], message: `duplicate scout name '${s.name}'` });
      seen.add(s.name);
    });
  });
export type WorkflowV2 = z.infer<typeof WorkflowV2>;

// ---------------------------------------------------------------------------
// trustHash
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256(canonical(spec) + "\n" + prompt): changes only when this Scout's own entry or prompt changes. */
export function trustHash(spec: ScoutSpec, prompt: string): string {
  return crypto.createHash("sha256").update(`${canonicalJson(spec)}\n${prompt}`, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// resolveWorkflow
// ---------------------------------------------------------------------------

export type Source = "kernel" | "host" | "repo";
/** `declared` is set when a higher layer overrode what the repo asked for. */
export interface Effective<T> {
  value: T;
  source: Source;
  declared?: T;
}

/** The host's contribution: tighten-only arms and ceilings, read from archangel.yaml and the Ledger. */
export interface HostWorkflowInput {
  shadowMode: boolean;
  maxAutoMergesPerDay: number;
  maxAutoPromotionsPerDay: number;
  scoutRunsPerDay: number;
  maxConcurrentThreads: number;
  /** Scout trust hashes whose auto-promotion was revoked (disagreed, reverted, or red main). */
  revokedTrustHashes: ReadonlySet<string>;
}

/** The repo's contribution at `mainSha`: the raw v2 file (null if absent) and `.agents/scouts/<name>.md` bodies. */
export interface RepoWorkflowInput {
  repo: string;
  mainSha: string;
  fileRaw: string | null;
  scoutPrompts: Readonly<Record<string, string>>;
}

export interface EffectiveScout extends ScoutSpec {
  prompt: string;
  trustHash: string;
  promotionEffective: Effective<"owner" | "auto">;
  revoked: boolean;
}

export type EffectiveWorkflow =
  | { repo: string; mainSha: string; status: "missing"; error: string }
  | { repo: string; mainSha: string; status: "invalid"; error: string; fileSha256: string }
  | {
      repo: string;
      mainSha: string;
      status: "ok";
      fileSha256: string;
      gate: GatePolicy;
      requiredChecks: string[];
      rubric?: string;
      landingBugfix: Effective<"owner" | "autonomous">;
      scouts: EffectiveScout[];
      caps: { autoMergesPerDay: number; autoPromotionsPerDay: number; scoutRunsPerDay: number; concurrent: number };
    };

/**
 * Pure. Kernel bounds are validation errors (status "invalid": the caller fails closed); host values clamp
 * and the clamp is recorded as provenance. There is no fallback to any other policy.
 */
export function resolveWorkflow(host: HostWorkflowInput, repoIn: RepoWorkflowInput): EffectiveWorkflow {
  const base = { repo: repoIn.repo, mainSha: repoIn.mainSha };
  if (repoIn.fileRaw === null || !repoIn.fileRaw.trim()) {
    return { ...base, status: "missing", error: "workflow file .agents/archangel.json not found" };
  }
  const fileSha256 = crypto.createHash("sha256").update(repoIn.fileRaw).digest("hex");
  let wf: WorkflowV2;
  try {
    const parsed = WorkflowV2.safeParse(JSON.parse(repoIn.fileRaw));
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { ...base, status: "invalid", error: msg, fileSha256 };
    }
    wf = parsed.data;
  } catch (err) {
    return { ...base, status: "invalid", error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`, fileSha256 };
  }
  const missingPrompt = wf.scouts.find((s) => repoIn.scoutPrompts[s.name] === undefined);
  if (missingPrompt) {
    return { ...base, status: "invalid", error: `scout '${missingPrompt.name}' has no .agents/scouts/${missingPrompt.name}.md`, fileSha256 };
  }

  const gate: GatePolicy = {
    maxNonTestLines: wf.gate.maxNonTestLines,
    maxTotalLines: wf.gate.maxTotalLines,
    maxFiles: wf.gate.maxFiles,
    extraProtectedPaths: wf.gate.protectedPaths,
    testFileGlobs: wf.gate.testFileGlobs,
    testDataGlobs: wf.gate.testDataGlobs,
    testBuildCmd: wf.gate.testBuildCmd,
    baseTestCmd: wf.gate.baseTestCmd,
    testCmd: wf.gate.testCmd,
    baseTestRuns: wf.gate.baseTestRuns,
    headTestRuns: wf.gate.headTestRuns,
  };

  const declaredLanding = wf.landing.bugfix;
  const landingBugfix: Effective<"owner" | "autonomous"> =
    host.shadowMode && declaredLanding === "autonomous"
      ? { value: "owner", source: "host", declared: declaredLanding }
      : { value: declaredLanding, source: "repo" };

  const scouts: EffectiveScout[] = wf.scouts.map((spec) => {
    const prompt = repoIn.scoutPrompts[spec.name]!;
    const hash = trustHash(spec, prompt);
    const revoked = host.revokedTrustHashes.has(hash);
    let promotionEffective: Effective<"owner" | "auto"> = { value: spec.promotion, source: "repo" };
    if (spec.promotion === "auto" && revoked) {
      promotionEffective = { value: "owner", source: "kernel", declared: "auto" };
    } else if (spec.promotion === "auto" && host.maxAutoPromotionsPerDay === 0) {
      promotionEffective = { value: "owner", source: "host", declared: "auto" };
    }
    return { ...spec, prompt, trustHash: hash, promotionEffective, revoked };
  });

  return {
    ...base,
    status: "ok",
    fileSha256,
    gate,
    requiredChecks: [...new Set([KERNEL.implicitRequiredCheck, ...wf.requiredChecks])],
    rubric: wf.review.rubric,
    landingBugfix,
    scouts,
    caps: {
      autoMergesPerDay: host.maxAutoMergesPerDay,
      autoPromotionsPerDay: host.maxAutoPromotionsPerDay,
      scoutRunsPerDay: host.scoutRunsPerDay,
      concurrent: host.maxConcurrentThreads,
    },
  };
}

/** Feature work always lands by owner merge; bugfix lands by the owner unless repo and host both allow autonomy. */
export function ownerMergesOnly(wf: Extract<EffectiveWorkflow, { status: "ok" }>, workClass: WorkClass): boolean {
  return workClass === "feature" || wf.landingBugfix.value === "owner";
}

// ---------------------------------------------------------------------------
// classifyChange
// ---------------------------------------------------------------------------

export type ChangeDirection = "tighten" | "loosen" | "changed";
export interface FieldChange {
  field: string;
  direction: ChangeDirection;
}

const eq = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Per-field effect of replacing `prev` with `next`. "changed" means a human must read it (no safe ordering). */
export function classifyChange(prev: WorkflowV2, next: WorkflowV2): FieldChange[] {
  const out: FieldChange[] = [];
  const add = (field: string, direction: ChangeDirection) => out.push({ field, direction });

  for (const k of ["maxNonTestLines", "maxTotalLines", "maxFiles"] as const) {
    if (next.gate[k] !== prev.gate[k]) add(`gate.${k}`, next.gate[k] > prev.gate[k] ? "loosen" : "tighten");
  }
  for (const k of ["baseTestRuns", "headTestRuns"] as const) {
    if (next.gate[k] !== prev.gate[k]) add(`gate.${k}`, next.gate[k] < prev.gate[k] ? "loosen" : "tighten");
  }
  for (const k of ["testFileGlobs", "testDataGlobs", "testCmd", "baseTestCmd", "testBuildCmd"] as const) {
    if (!eq(prev.gate[k], next.gate[k])) add(`gate.${k}`, "changed");
  }
  setChange("gate.protectedPaths", prev.gate.protectedPaths, next.gate.protectedPaths, add);
  setChange("requiredChecks", prev.requiredChecks, next.requiredChecks, add);
  if (!eq(prev.review.rubric, next.review.rubric)) add("review.rubric", "changed");
  if (prev.landing.bugfix !== next.landing.bugfix) {
    add("landing.bugfix", next.landing.bugfix === "autonomous" ? "loosen" : "tighten");
  }

  const before = new Map(prev.scouts.map((s) => [s.name, s]));
  const after = new Map(next.scouts.map((s) => [s.name, s]));
  for (const [name, s] of after) {
    const old = before.get(name);
    if (!old) {
      add(`scouts.${name}`, s.promotion === "auto" || s.includeMetrics ? "loosen" : "changed");
      continue;
    }
    if (old.promotion !== s.promotion) add(`scouts.${name}.promotion`, s.promotion === "auto" ? "loosen" : "tighten");
    if (old.includeMetrics !== s.includeMetrics) add(`scouts.${name}.includeMetrics`, s.includeMetrics ? "loosen" : "tighten");
    for (const k of ["schedule", "maxProposals", "skills"] as const) {
      if (!eq(old[k], s[k])) add(`scouts.${name}.${k}`, "changed");
    }
  }
  for (const name of before.keys()) if (!after.has(name)) add(`scouts.${name}`, "tighten");
  return out;
}

/** Adding entries tightens; removing any entry loosens. */
function setChange(
  field: string,
  prev: readonly string[],
  next: readonly string[],
  add: (field: string, d: ChangeDirection) => void,
): void {
  const p = new Set(prev);
  const n = new Set(next);
  const removed = prev.some((x) => !n.has(x));
  const added = next.some((x) => !p.has(x));
  if (removed) add(field, "loosen");
  else if (added) add(field, "tighten");
}

export function loosens(changes: readonly FieldChange[]): boolean {
  return changes.some((c) => c.direction === "loosen");
}
