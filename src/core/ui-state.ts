import { z } from "zod";
import { CORRECTION_WINDOW_DAYS, correctionCategories, type CorrectionCounts } from "./corrections.js";
import type { Ledger, StageMetrics } from "../ledger/store.js";
import type { EffectiveWorkflow, OkWorkflow, Workflow } from "./workflow.js";
import { draftFromEffective } from "./ui-propose.js";
import { describeEscalation, formatDecisionClass } from "./escalations.js";
import type { ThreadRecord } from "../ledger/schema.js";
import type { Phase } from "./thread-machine.js";

export const STAGES = [
  "Working",
  "Waiting on CI",
  "In review",
  "Ready for owner",
  "Needs you",
  "Owner driving",
  "Queued",
  "Done in last 7 days",
] as const;
export type Stage = (typeof STAGES)[number];

/** The Threads page groups by what each Thread needs from the owner, most urgent first. */
export const NEED_GROUPS = ["Needs you", "Ready for owner", "Stuck", "In review", "Waiting on CI", "Working", "Queued", "Done in last 7 days"] as const;
export type NeedGroup = (typeof NEED_GROUPS)[number];
/** No phase change for this long, outside `queued`, means a Thread is stuck rather than working. */
export const STUCK_MS = 6 * 3_600_000;

export interface UiItem {
  repo: string;
  issueNumber: number;
  prNumber: number | null;
  title: string;
  phase: string;
  since: number;
}

export interface UiState {
  generatedAt: number;
  needsYou: Array<UiItem & { decisionClass: string; recommendation: string; code: string; reason: string }>;
  /** The same Threads grouped by what they need (Threads page); `Done in last 7 days` is bounded like `stages`. */
  groups: Record<NeedGroup, UiItem[]>;
  stages: Record<Stage, UiItem[]>;
  outcomes: ReturnType<Ledger["computeMetrics"]>["outcomes"];
  /** Owner corrections over the last 30 days, all repos (closed categories only). */
  corrections: CorrectionCounts;
  autonomySteps: Record<string, number>;
  /** Last daemon heartbeat (ms), or null when no daemon lock exists: the dashboard shows an offline banner when it is old or null. */
  daemonHeartbeatAt: number | null;
  /** Last 14 local days, oldest first. */
  daily: Array<{ day: string; merged: number; reworkAttempts: number }>;
  scouts: Array<{ repo: string; issueNumber: number; scoutName: string; autoPromoted: boolean; hasThread: boolean; createdAt: number }>;
}

const DAY_MS = 86_400_000;

function stageOf(phase: Phase, updatedAt: number, now: number): Stage | null {
  switch (phase.kind) {
    case "working":
      return "Working";
    case "awaiting_gate":
      return "Waiting on CI";
    case "reviewing":
    case "landing":
      return "In review";
    case "shadow_ready":
      return "Ready for owner";
    case "needs_you":
      return "Needs you";
    case "owner_driving":
      return "Owner driving";
    case "queued":
      return "Queued";
    case "done":
      return now - updatedAt <= 7 * DAY_MS ? "Done in last 7 days" : null;
  }
}

const OUTCOME_LABELS = {
  merged: "merged",
  owner_merged: "owner merged",
  pr_closed: "PR closed",
  reverted: "reverted",
  abandoned: "abandoned",
} as const;

/** What the dashboard shows next to a Thread: the outcome for finished ones, else the phase. */
function phaseLabel(phase: Phase): string {
  return phase.kind === "done" ? OUTCOME_LABELS[phase.outcome] : phase.kind;
}

function prOf(phase: Phase): number | null {
  return "prNumber" in phase && typeof phase.prNumber === "number" ? phase.prNumber : null;
}

function needGroupOf(phase: Phase, updatedAt: number, now: number): NeedGroup | null {
  const stage = stageOf(phase, updatedAt, now);
  if (stage === null) return null;
  const active = phase.kind === "working" || phase.kind === "awaiting_gate" || phase.kind === "reviewing" || phase.kind === "landing";
  if (active && now - updatedAt > STUCK_MS) return "Stuck";
  switch (stage) {
    case "Owner driving":
      return null; // the owner is already on it
    default:
      return stage;
  }
}

/** Pure: Threads grouped by what they need, each group newest first (Needs you oldest first, as in the queue). */
export function groupByNeed(threads: ThreadRecord[], now: number): Record<NeedGroup, UiItem[]> {
  const groups = Object.fromEntries(NEED_GROUPS.map((g) => [g, [] as UiItem[]])) as Record<NeedGroup, UiItem[]>;
  for (const t of threads) {
    const g = needGroupOf(t.phase, t.updatedAt, now);
    if (g) groups[g].push({ repo: t.repo, issueNumber: t.issueNumber, prNumber: prOf(t.phase), title: t.title, phase: phaseLabel(t.phase), since: t.updatedAt });
  }
  for (const [g, list] of Object.entries(groups)) list.sort((a, b) => (g === "Needs you" ? a.since - b.since : b.since - a.since));
  return groups;
}

/** Groups Threads by stage (and lists Needs You items with their class and recommendation). Shared by the dashboard and `archangel status`. */
export function groupThreads(
  threads: ThreadRecord[],
  now: number,
): { stages: Record<Stage, UiItem[]>; needsYou: UiState["needsYou"] } {
  const stages = Object.fromEntries(STAGES.map((s) => [s, [] as UiItem[]])) as Record<Stage, UiItem[]>;
  const needsYou: UiState["needsYou"] = [];
  for (const t of threads) {
    const item: UiItem = {
      repo: t.repo,
      issueNumber: t.issueNumber,
      prNumber: prOf(t.phase),
      title: t.title,
      phase: phaseLabel(t.phase),
      since: t.updatedAt,
    };
    const stage = stageOf(t.phase, t.updatedAt, now);
    if (stage) stages[stage].push(item);
    if (t.phase.kind === "needs_you") {
      const p = describeEscalation(t.phase.code);
      needsYou.push({ ...item, decisionClass: formatDecisionClass(p.decisionClass), recommendation: p.recommendation, code: t.phase.code, reason: t.phase.reason });
    }
  }
  for (const list of Object.values(stages)) list.sort((a, b) => b.since - a.since);
  needsYou.sort((a, b) => a.since - b.since);
  return { stages, needsYou };
}

export function formatAge(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Pure read of the Ledger into the dashboard's data. Never writes; makes no network calls. */
export function buildUiState(ledger: Ledger, now = Date.now()): UiState {
  const threads = ledger.listAllThreads();
  const { stages, needsYou } = groupThreads(threads, now);
  const repos = [...new Set(threads.map((t) => t.repo))];
  const known = new Set(threads.map((t) => `${t.repo}#${t.issueNumber}`));
  return {
    generatedAt: now,
    needsYou,
    groups: groupByNeed(threads, now),
    stages,
    outcomes: ledger.computeMetrics({ now }).outcomes,
    corrections: ledger.computeCorrections({ sinceMs: now - CORRECTION_WINDOW_DAYS * DAY_MS, now }),
    daemonHeartbeatAt: ledger.daemonHeartbeatAt(),
    daily: ledger.dailyOutcomes(14, now),
    autonomySteps: Object.fromEntries(repos.map((r) => [r, ledger.autonomousStepsSinceOwner(r)])),
    scouts: ledger.listScoutProposals(25).map((p) => ({
      repo: p.repo,
      issueNumber: p.issueNumber,
      scoutName: p.scoutName,
      autoPromoted: p.autoPromoted,
      hasThread: known.has(`${p.repo}#${p.issueNumber}`),
      createdAt: p.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Pipeline view (V4): the resolved workflow, where each value came from, and per-stage metrics.
// ---------------------------------------------------------------------------

export type SourceChip = "kernel" | "host" | "repo";
export interface PipelineItem {
  label: string;
  value: string;
  source: SourceChip;
}
export interface PipelineStage {
  id: "intake" | "scouts" | "promotion" | "work_class" | "gate" | "review" | "landing" | "needs_you";
  title: string;
  items: PipelineItem[];
  /** "repo says X, host caps at Y" notes, only where a higher layer overrode the repo. */
  clamps: string[];
  metrics: string[];
}
export interface PipelineRepo {
  repo: string;
  /** missing/invalid fail closed: the repo is halted until the file is fixed. `unresolved` = the daemon has not resolved it yet; `unreadable` = the cached copy is corrupt (the next tick rewrites it). */
  status: "ok" | "missing" | "invalid" | "unresolved" | "unreadable";
  error?: string;
  mainSha?: string;
  fileSha256?: string;
  /** Editable version 1 draft of the current file (only when status is ok); Scout prompts are not included. */
  draft?: Workflow;
  stages: PipelineStage[];
}
export interface WorkflowsState {
  generatedAt: number;
  windowDays: number;
  repos: PipelineRepo[];
}

const WINDOW_DAYS = 14;
/** Pitch outcomes for the Scouts card; nothing when the repo has never had a pitch activity. */
export function pitchMetricLines(p: StageMetrics["pitches"]): string[] {
  if (p.filed + p.vetoed + p.open === 0 && p.lastDecided === 0) return [];
  return [
    `pitches (${WINDOW_DAYS}d): ${p.filed} filed, ${p.promoted} promoted, ${p.declined} declined, ${p.expired} expired, ${p.vetoed} vetoed; ${p.open} open`,
    `pitch promotion rate (last ${p.lastDecided} decided): ${p.lastDecided === 0 ? "no decided pitches yet" : `${p.lastDecidedPromoted}/${p.lastDecided}`}`,
  ];
}

const list = (xs: readonly string[]) => (xs.length > 0 ? xs.join(", ") : "none");
const pairs = (rec: Record<string, number>) => {
  const e = Object.entries(rec);
  return e.length > 0 ? e.map(([k, v]) => `${k}=${v}`).join(", ") : "none";
};

/** Pure. `wf` is the cached EffectiveWorkflow (untrusted JSON from system_state); only whitelisted fields are read, Scout prompts never leave the Ledger. */
export function describeWorkflow(repo: string, wf: EffectiveWorkflow | null, m: StageMetrics): PipelineRepo {
  const intakeMetrics = [
    `queued: ${m.intake.queued}${m.intake.oldestQueuedAgeSec === null ? "" : `, oldest ${formatAge(m.intake.oldestQueuedAgeSec * 1000)}`}`,
    `rejected: ${pairs(m.intake.rejections)}`,
  ];
  const kernelStages = (ok: OkWorkflow | null): PipelineStage[] => {
    const scoutEntries = Object.entries(m.scouts);
    return [
      {
        id: "intake",
        title: "Intake",
        items: [{ label: "rule", value: "owner-authored issue, owner-applied ready-for-agent, pinned body hash", source: "kernel" }],
        clamps: [],
        metrics: intakeMetrics,
      },
      {
        id: "scouts",
        title: "Scouts",
        items: ok
          ? [
              ...ok.scouts.map((s) => ({
                label: s.name,
                value: `${s.schedule}, max ${s.maxProposals}/run, skills: ${list(s.skills)}${s.includeMetrics ? ", metrics" : ""}`,
                source: "repo" as const,
              })),
              { label: "enabled on this host", value: ok.caps.scoutsEnabled ? "yes" : "no", source: "host" as const },
              { label: "runs/day", value: String(ok.caps.scoutRunsPerDay), source: "host" as const },
            ]
          : [],
        clamps: ok && !ok.caps.scoutsEnabled && ok.scouts.length > 0 ? ["Scouts are disabled on this host (scouts.enabled is false): the repo declares them but nothing runs"] : [],
        metrics: [
          ...(scoutEntries.length === 0
            ? ["no Scout activity"]
            : scoutEntries.map(([name, s]) => `${name}: ${s.runs} runs, ${s.filed} filed, ${s.becameThread} Threads, ${s.merged} merged, ${s.reverted} reverted, ${s.secretsBlocked} secrets blocked`)),
          ...pitchMetricLines(m.pitches),
        ],
      },
      {
        id: "promotion",
        title: "Promotion",
        items: ok
          ? [
              ...ok.scouts.map((s) => ({ label: s.name, value: s.promotionEffective.value, source: s.promotionEffective.source })),
              { label: "auto-promotions/day", value: String(ok.caps.autoPromotionsPerDay), source: "host" as const },
            ]
          : [],
        clamps: ok
          ? ok.scouts.flatMap((s) =>
              s.promotionEffective.declared !== undefined
                ? [`${s.name}: repo says ${s.promotionEffective.declared}, ${s.promotionEffective.source === "kernel" ? "kernel revoked it (an owner-merged edit to this Scout re-arms it)" : "host caps at 0 auto-promotions"}`]
                : [],
            )
          : [],
        metrics: [`auto-promotions: ${m.promotion.autoPromotionsLast24h} in 24h, ${m.promotion.autoPromotionsInWindow} in window`],
      },
      {
        id: "work_class",
        title: "Work class",
        items: [{ label: "rule", value: "owner-labelled class:feature; scout proposals are always bugfix", source: "kernel" }],
        clamps: [],
        metrics: (["bugfix", "feature"] as const).map(
          (c) => `${c}: ${m.workClass[c].threads} Threads, ${m.workClass[c].merged} merged, ${m.workClass[c].attemptsPerMerge ?? "n/a"} attempts/merge`,
        ),
      },
      {
        id: "gate",
        title: "Gate",
        items: ok
          ? [
              { label: "bounds", value: `<= ${ok.gate.maxNonTestLines} non-test lines, ${ok.gate.maxTotalLines} total, ${ok.gate.maxFiles} files`, source: "repo" },
              { label: "test runs", value: `base ${ok.gate.baseTestRuns}, head ${ok.gate.headTestRuns}`, source: "repo" },
              { label: "required checks", value: list(ok.requiredChecks), source: "repo" },
              { label: "protected paths", value: `.github/, .agents/ and ${list(ok.gate.extraProtectedPaths)}`, source: "kernel" },
            ]
          : [],
        clamps: [],
        metrics: [
          `attempts: ${m.gate.attempts.total} (${m.gate.attempts.succeeded} ok, ${m.gate.attempts.failed} failed)`,
          `escalations: ${pairs(m.gate.escalations)}`,
        ],
      },
      {
        id: "review",
        title: "Review",
        items: [
          { label: "quorum", value: "2 independent vendors, never the implementer's", source: "kernel" },
          ...(ok ? [{ label: "rubric", value: ok.rubric ? "custom" : "default", source: "repo" as const }] : []),
        ],
        clamps: [],
        metrics: [
          `veto/approve: ${Object.entries(m.review.byVendor).map(([v, r]) => `${v} ${r.veto}/${r.approve}`).join(", ") || "none"}`,
          `outages: ${m.review.outages}`,
        ],
      },
      {
        id: "landing",
        title: "Landing",
        items: ok
          ? [
              { label: "bugfix", value: ok.landingBugfix.value, source: ok.landingBugfix.source },
              { label: "feature", value: "owner", source: "kernel" },
              { label: "merges/day", value: String(ok.caps.autoMergesPerDay), source: "host" },
            ]
          : [],
        clamps:
          ok && ok.landingBugfix.declared !== undefined
            ? [`bugfix landing: repo says ${ok.landingBugfix.declared}, host shadowMode caps at ${ok.landingBugfix.value}`]
            : [],
        metrics: [
          `merged: ${m.landing.autoMerged} auto, ${m.landing.ownerMerged} owner`,
          `reverts ${m.landing.reverts}, disagreements ${m.landing.disagreements}, autonomy-cap hits ${m.landing.autonomyCapHits}`,
        ],
      },
      {
        id: "needs_you",
        title: "Needs You",
        items: [{ label: "notifications", value: "host settings (read-only here)", source: "host" }],
        clamps: [],
        metrics: [`open by class: ${pairs(m.needsYou.byDecisionClass)}`],
      },
    ];
  };

  if (wf === null) return { repo, status: "unresolved", stages: kernelStages(null) };
  if (wf.status === "missing") return { repo, status: "missing", error: wf.error, mainSha: wf.mainSha, stages: kernelStages(null) };
  if (wf.status === "invalid") {
    return { repo, status: "invalid", error: wf.error, mainSha: wf.mainSha, fileSha256: wf.fileSha256, stages: kernelStages(null) };
  }
  let draft: Workflow;
  try {
    draft = draftFromEffective(wf);
  } catch (e) {
    // A workflow that resolves but cannot be turned into an editable draft is not "ok": say so instead of hiding the editor.
    return {
      repo,
      status: "unreadable",
      error: `The workflow resolved but its editable draft could not be built: ${e instanceof Error ? e.message : String(e)}`,
      mainSha: wf.mainSha,
      fileSha256: wf.fileSha256,
      stages: kernelStages(wf),
    };
  }
  return { repo, status: "ok", mainSha: wf.mainSha, fileSha256: wf.fileSha256, draft, stages: kernelStages(wf) };
}

const Source = z.enum(["kernel", "host", "repo"]);
const Eff = (v: z.ZodType) => z.object({ value: v, source: Source, declared: v.optional() }).passthrough();
const CachedBase = { repo: z.string(), mainSha: z.string() };
/** The cached workflow is untrusted JSON from system_state (it may be corrupt or from an older shape): only a value that fits is rendered. */
const CachedWorkflow = z.union([
  z.object({ ...CachedBase, status: z.literal("missing"), error: z.string() }).passthrough(),
  z.object({ ...CachedBase, status: z.literal("invalid"), error: z.string(), fileSha256: z.string() }).passthrough(),
  z
    .object({
      ...CachedBase,
      status: z.literal("ok"),
      fileSha256: z.string(),
      gate: z
        .object({
          maxNonTestLines: z.number(),
          maxTotalLines: z.number(),
          maxFiles: z.number(),
          baseTestRuns: z.number(),
          headTestRuns: z.number(),
          extraProtectedPaths: z.array(z.string()),
        })
        .passthrough(),
      requiredChecks: z.array(z.string()),
      rubric: z.string().optional(),
      landingBugfix: Eff(z.enum(["owner", "autonomous"])),
      scouts: z.array(
        z
          .object({
            name: z.string(),
            schedule: z.string(),
            maxProposals: z.number(),
            skills: z.array(z.string()),
            includeMetrics: z.boolean(),
            promotionEffective: Eff(z.enum(["owner", "auto"])),
          })
          .passthrough(),
      ),
      caps: z
        .object({ autoMergesPerDay: z.number(), autoPromotionsPerDay: z.number(), scoutRunsPerDay: z.number(), scoutsEnabled: z.boolean(), concurrent: z.number() })
        .passthrough(),
    })
    .passthrough(),
]);

/** `/api/workflows`: every repo the Ledger knows, with its cached workflow (no GitHub calls). */
export function buildWorkflowsState(ledger: Ledger, now = Date.now()): WorkflowsState {
  const cached = new Map(ledger.listCachedWorkflows().map((c) => [c.repo, CachedWorkflow.safeParse(c.workflow)]));
  const repos = [...new Set([...cached.keys(), ...ledger.listAllThreads().map((t) => t.repo)])].sort();
  const since = now - WINDOW_DAYS * DAY_MS;
  return {
    generatedAt: now,
    windowDays: WINDOW_DAYS,
    repos: repos.map((repo) => {
      const metrics = ledger.computeStageMetrics(repo, since, now);
      const hit = cached.get(repo);
      if (hit && !hit.success) {
        return { ...describeWorkflow(repo, null, metrics), status: "unreadable" as const, error: "The cached workflow could not be read; the daemon rewrites it on its next tick." };
      }
      return describeWorkflow(repo, hit ? (hit.data as unknown as EffectiveWorkflow) : null, metrics);
    }),
  };
}
