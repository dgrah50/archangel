import crypto from "node:crypto";
import { z } from "zod";
import { GatePolicySchema, type GatePolicy } from "../config.js";
import { SKILL_REF_RE } from "./skills.js";
import type { WorkClass } from "./work-class.js";

/**
 * Pure V4 workflow core: KERNEL (invariants and maxima), the repo file schema, the resolver and the
 * tighten/loosen classifier. Nothing here does I/O, so it can ship in the pinned Gate bundle.
 */

const GATE_DEFAULTS = GatePolicySchema.parse({});

/**
 * Universal, language-agnostic protected paths: no repo file can unprotect them. Repo-specific paths
 * (lockfiles, build files) belong in the workflow file's `gate.protectedPaths`.
 */
export const UNIVERSAL_PROTECTED_PREFIXES = [".github/", ".agents/"];
export const UNIVERSAL_PROTECTED_EXACT = new Set([
  ".pre-commit-config.yaml",
  ".pre-commit-config.yml",
  ".gitattributes",
  ".gitmodules",
  "claude.md",
  "agents.md",
]);

/**
 * Invariants no config can express. Numbers are today's GatePolicySchema defaults (which the CI Gate already
 * enforced as ceilings/floors); the protected paths are the constants above.
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
  gateCheck: "Gate",
  reviewQuorum: 2,
  maxScouts: 5,
  /** One factory retry per Thread, for life: not configurable upward, never renewed except by an owner retry (which ends factory involvement). */
  factoryRetriesPerThread: 1,
  /** Factory retries per repo in any rolling 24 hours. */
  factoryRetriesPerRepoPerDay: 3,
  /** Per-Thread recommendation runs (triage's own, or the recommendation-only run) per repo in any rolling 24 hours; each needs_you entry gets at most one. */
  recommendationsPerRepoPerDay: 10,
} as const;

const NonBlank = z.string().refine((s) => s.trim().length > 0, "must not be blank");
/** A git-relative glob: git emits paths without a leading `/` or `./`, so such a glob could never match (and would silently protect nothing). */
const Glob = z
  .string()
  .max(200)
  .refine(
    (g) => g.trim() === g && g.length > 0 && !g.startsWith("/") && !g.startsWith("./") && g !== "." && !g.split("/").includes(".."),
    "must be a repo-relative glob (no leading '/' or './', no '..', not blank)",
  );
/** A repo-relative glob for the JUnit report: no absolute paths, no `..`, no backslashes, only path-ish characters. */
const SafeRelativeGlob = Glob.refine(
  (g) => /^[\w@+./*?-]+$/.test(g) && !g.startsWith("/") && !g.split("/").includes(".."),
  "junitReport must be a relative path glob inside the repo (no '..', no absolute path)",
);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/);

export const ScoutSpec = z
  .object({
    name: Slug,
    /** `bug` Scouts file reproducible bugs; `pitch` Scouts file at most one owner-decided proposal a week. */
    kind: z.enum(["bug", "pitch"]).default("bug"),
    schedule: z.enum(["daily", "weekly", "manual"]).default("manual"),
    maxProposals: z.number().int().min(1).max(3).default(2),
    skills: z.array(z.string().regex(SKILL_REF_RE)).max(12).default([]),
    includeMetrics: z.boolean().default(false),
    promotion: z.enum(["owner", "auto"]).default("owner"),
  })
  .strict();
export type ScoutSpec = z.infer<typeof ScoutSpec>;

export const Workflow = z
  .object({
    version: z.literal(1),
    gate: z
      .object({
        maxNonTestLines: z.number().int().min(1).max(KERNEL.maxNonTestLines).default(KERNEL.maxNonTestLines),
        maxTotalLines: z.number().int().min(1).max(KERNEL.maxTotalLines).default(KERNEL.maxTotalLines),
        maxFiles: z.number().int().min(1).max(KERNEL.maxFiles).default(KERNEL.maxFiles),
        baseTestRuns: z.number().int().min(KERNEL.minBaseTestRuns).max(10).default(KERNEL.minBaseTestRuns),
        headTestRuns: z.number().int().min(KERNEL.minHeadTestRuns).max(10).default(KERNEL.minHeadTestRuns),
        testFileGlobs: z.array(Glob).min(1),
        testDataGlobs: z.array(Glob).default([]),
        testCmd: NonBlank,
        baseTestCmd: NonBlank.optional(),
        testBuildCmd: NonBlank.optional(),
        junitReport: SafeRelativeGlob.optional(),
        protectedPaths: z.array(Glob).default([]),
      })
      .strict(),
    /** Must name `Gate` and at least one other CI check, or landing could never see main green. */
    requiredChecks: z.array(NonBlank),
    review: z.object({ rubric: z.string().max(4000).optional() }).strict().default({}),
    landing: z.object({ bugfix: z.enum(["owner", "autonomous"]).default("owner") }).strict().default({ bugfix: "owner" }),
    /** `once` lets the factory retry a Thread once instead of escalating (see KERNEL.factoryRetriesPerThread); `off` can only tighten. */
    escalations: z.object({ factoryRetry: z.enum(["off", "once"]).default("off") }).strict().default({ factoryRetry: "off" }),
    scouts: z.array(ScoutSpec).max(KERNEL.maxScouts).default([]),
  })
  .strict()
  .superRefine((wf, ctx) => {
    if (!wf.requiredChecks.includes(KERNEL.gateCheck) || !wf.requiredChecks.some((c) => c !== KERNEL.gateCheck)) {
      ctx.addIssue({ code: "custom", path: ["requiredChecks"], message: `requiredChecks must include '${KERNEL.gateCheck}' and at least one other CI check` });
    }
    if (wf.gate.maxTotalLines < wf.gate.maxNonTestLines) {
      ctx.addIssue({ code: "custom", path: ["gate", "maxTotalLines"], message: "maxTotalLines must be >= maxNonTestLines" });
    }
    const seen = new Set<string>();
    wf.scouts.forEach((s, i) => {
      if (seen.has(s.name)) ctx.addIssue({ code: "custom", path: ["scouts", i, "name"], message: `duplicate scout name '${s.name}'` });
      seen.add(s.name);
      // Kernel rules for pitch Scouts: no config can make one auto-promote, file more than one a run, or run daily.
      if (s.kind === "pitch") {
        if (s.promotion !== "owner") ctx.addIssue({ code: "custom", path: ["scouts", i, "promotion"], message: "a pitch Scout is never auto-promoted (promotion must be 'owner')" });
        if (s.maxProposals !== 1) ctx.addIssue({ code: "custom", path: ["scouts", i, "maxProposals"], message: "a pitch Scout files at most 1 pitch per run (maxProposals must be 1)" });
        if (s.schedule === "daily") ctx.addIssue({ code: "custom", path: ["scouts", i, "schedule"], message: "a pitch Scout must be 'weekly' or 'manual'" });
      }
    });
  });
export type Workflow = z.infer<typeof Workflow>;

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
  // `kind: "bug"` is the default: leaving it out keeps every existing Scout's hash (and its revocation state) unchanged.
  const { kind, ...rest } = spec;
  const hashed = kind === "bug" ? rest : spec;
  return crypto.createHash("sha256").update(`${canonicalJson(hashed)}\n${prompt}`, "utf8").digest("hex");
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
  /** `scouts.enabled` on the host: when false no Scout runs, whatever the repo declares. */
  scoutsEnabled: boolean;
  maxConcurrentThreads: number;
  /** Host kill switch (`factoryRetry` in archangel.yaml): false turns factory retries off for every repo. */
  factoryRetry: boolean;
  /** True when auto-promotion of this exact Scout version was revoked (disagreed, reverted, or red main). */
  isRevoked: (scoutName: string, trustHash: string) => boolean;
}

/** The repo's contribution at `mainSha`: the raw workflow file (null if absent) and `.agents/scouts/<name>.md` bodies. */
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
      factoryRetry: Effective<"off" | "once">;
      scouts: EffectiveScout[];
      caps: { autoMergesPerDay: number; autoPromotionsPerDay: number; scoutRunsPerDay: number; scoutsEnabled: boolean; concurrent: number };
    };

/**
 * Pure. Kernel bounds are validation errors (status "invalid": the caller fails closed); host values clamp
 * and the clamp is recorded as provenance. There is no fallback to any other policy.
 */
export type OkWorkflow = Extract<EffectiveWorkflow, { status: "ok" }>;

/** The one mapping from the workflow file's `gate` block to the policy the Broker and the CI Gate both enforce. */
export function toGatePolicy(g: Workflow["gate"]): GatePolicy {
  return {
    maxNonTestLines: g.maxNonTestLines,
    maxTotalLines: g.maxTotalLines,
    maxFiles: g.maxFiles,
    extraProtectedPaths: g.protectedPaths,
    testFileGlobs: g.testFileGlobs,
    testDataGlobs: g.testDataGlobs,
    testBuildCmd: g.testBuildCmd,
    baseTestCmd: g.baseTestCmd,
    testCmd: g.testCmd,
    junitReport: g.junitReport,
    baseTestRuns: g.baseTestRuns,
    headTestRuns: g.headTestRuns,
  };
}

export function resolveWorkflow(host: HostWorkflowInput, repoIn: RepoWorkflowInput): EffectiveWorkflow {
  const base = { repo: repoIn.repo, mainSha: repoIn.mainSha };
  if (repoIn.fileRaw === null || !repoIn.fileRaw.trim()) {
    return { ...base, status: "missing", error: "workflow file .agents/archangel.json not found" };
  }
  const fileSha256 = crypto.createHash("sha256").update(repoIn.fileRaw).digest("hex");
  let wf: Workflow;
  try {
    const parsed = Workflow.safeParse(JSON.parse(repoIn.fileRaw));
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { ...base, status: "invalid", error: msg, fileSha256 };
    }
    wf = parsed.data;
  } catch (err) {
    return { ...base, status: "invalid", error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`, fileSha256 };
  }
  // Own properties only: a Scout named "constructor" must not find Object.prototype.constructor as its prompt.
  const missingPrompt = wf.scouts.find((s) => !Object.hasOwn(repoIn.scoutPrompts, s.name));
  if (missingPrompt) {
    return { ...base, status: "invalid", error: `scout '${missingPrompt.name}' has no .agents/scouts/${missingPrompt.name}.md`, fileSha256 };
  }
  // A Scout with no prompt text and no skills would run with no instructions at all.
  const blank = wf.scouts.find((s) => s.skills.length === 0 && repoIn.scoutPrompts[s.name]!.trim() === "");
  if (blank) {
    return { ...base, status: "invalid", error: `scout '${blank.name}' has an empty prompt file and no skills`, fileSha256 };
  }

  const gate = toGatePolicy(wf.gate);

  const declaredLanding = wf.landing.bugfix;
  const landingBugfix: Effective<"owner" | "autonomous"> =
    host.shadowMode && declaredLanding === "autonomous"
      ? { value: "owner", source: "host", declared: declaredLanding }
      : { value: declaredLanding, source: "repo" };

  const declaredRetry = wf.escalations.factoryRetry;
  const factoryRetry: Effective<"off" | "once"> =
    !host.factoryRetry && declaredRetry === "once"
      ? { value: "off", source: "host", declared: declaredRetry }
      : { value: declaredRetry, source: "repo" };

  const scouts: EffectiveScout[] = wf.scouts.map((spec) => {
    const prompt = repoIn.scoutPrompts[spec.name]!.trim();
    const hash = trustHash(spec, prompt);
    const revoked = host.isRevoked(spec.name, hash);
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
    requiredChecks: [...new Set(wf.requiredChecks)],
    rubric: wf.review.rubric,
    landingBugfix,
    factoryRetry,
    scouts,
    caps: {
      autoMergesPerDay: host.maxAutoMergesPerDay,
      autoPromotionsPerDay: host.maxAutoPromotionsPerDay,
      scoutRunsPerDay: host.scoutRunsPerDay,
      scoutsEnabled: host.scoutsEnabled,
      concurrent: host.maxConcurrentThreads,
    },
  };
}

/** Feature work always lands by owner merge; bugfix lands by the owner unless repo and host both allow autonomy. */
export function ownerMergesOnly(wf: OkWorkflow, workClass: WorkClass): boolean {
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
export function classifyChange(prev: Workflow, next: Workflow): FieldChange[] {
  const out: FieldChange[] = [];
  const add = (field: string, direction: ChangeDirection) => out.push({ field, direction });

  for (const k of ["maxNonTestLines", "maxTotalLines", "maxFiles"] as const) {
    if (next.gate[k] !== prev.gate[k]) add(`gate.${k}`, next.gate[k] > prev.gate[k] ? "loosen" : "tighten");
  }
  for (const k of ["baseTestRuns", "headTestRuns"] as const) {
    if (next.gate[k] !== prev.gate[k]) add(`gate.${k}`, next.gate[k] < prev.gate[k] ? "loosen" : "tighten");
  }
  for (const k of ["testFileGlobs", "testDataGlobs", "testCmd", "baseTestCmd"] as const) {
    if (!eq(prev.gate[k], next.gate[k])) add(`gate.${k}`, "changed");
  }
  // Setting a report path adds a stricter red-on-base proof; removing it falls back to exit codes only.
  if (prev.gate.junitReport !== next.gate.junitReport) {
    add("gate.junitReport", !prev.gate.junitReport ? "tighten" : !next.gate.junitReport ? "loosen" : "changed");
  }
  // The build command verifies a new test compiles against base: dropping it loosens red-on-base, adding it tightens.
  if (prev.gate.testBuildCmd !== next.gate.testBuildCmd) {
    add("gate.testBuildCmd", !prev.gate.testBuildCmd ? "tighten" : !next.gate.testBuildCmd ? "loosen" : "changed");
  }
  setChange("gate.protectedPaths", prev.gate.protectedPaths, next.gate.protectedPaths, add);
  setChange("requiredChecks", prev.requiredChecks, next.requiredChecks, add);
  if (!eq(prev.review.rubric, next.review.rubric)) add("review.rubric", "changed");
  if (prev.landing.bugfix !== next.landing.bugfix) {
    add("landing.bugfix", next.landing.bugfix === "autonomous" ? "loosen" : "tighten");
  }

  if (prev.escalations.factoryRetry !== next.escalations.factoryRetry) {
    add("escalations.factoryRetry", next.escalations.factoryRetry === "once" ? "loosen" : "tighten");
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
    for (const k of ["kind", "schedule", "maxProposals", "skills"] as const) {
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
