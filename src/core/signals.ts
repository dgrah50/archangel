import { z } from "zod";
import type { GitHubClient } from "../github/client.js";
import { formatDayKey, type Ledger } from "../ledger/store.js";
import { SIGNAL_KINDS, type SignalKind } from "./signal-kinds.js";
import { emit } from "./telemetry.js";
import { ANOMALY_METRICS, anomalyEventId, detectAnomalies, TELEMETRY_SCOUT_EVERY_MS } from "./telemetry-scout.js";
import { policyRegressions } from "./regression-watch.js";
import { REPO_RE } from "./telemetry-events.js";
import { actionAllowed, ruleKey, type SignalRule, type SignalsConfig } from "./signal-rules.js";

/** Signals older than this are never actioned, and an adapter with no watermark reads back this far. */
export const SIGNAL_LOOKBACK_MS = 7 * 86_400_000;
/** The research fetcher runs at most this often. */
const RESEARCH_EVERY_MS = 86_400_000;
/** An adapter polls GitHub at most this often. */
export const SIGNAL_POLL_MS = 10 * 60_000;

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/** Closed payload shapes: numbers, enums and tightly patterned tokens only. Free text from outside (titles, descriptions) never enters a signal. */
const PAYLOADS = {
  pr_merged: z.object({ number: z.number().int().positive() }).strict(),
  release: z.object({ tag: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,99}$/) }).strict(),
  advisory: z
    .object({
      number: z.number().int().positive(),
      severity: z.enum(["low", "medium", "high", "critical"]),
      ghsaId: z.string().regex(/^GHSA(-[a-z0-9]{4}){3}$/),
    })
    .strict(),
  research: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), results: z.number().int().min(1).max(1000) }).strict(),
  schedule: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), slot: z.string().regex(/^[0-9a-zA-Z-]{1,20}$/) }).strict(),
  telemetry_anomaly: z
    .object({
      metric: z.enum(ANOMALY_METRICS),
      window: z.literal("24h"),
      baseline: z.number().finite(),
      observed: z.number().finite(),
      ratio: z.number().finite(),
      repo: z.string().regex(REPO_RE),
    })
    .strict(),
  policy_regression: z
    .object({
      repo: z.string().regex(REPO_RE),
      workflowSha: z.string().regex(SHA256_RE),
      promptSha: z.string().regex(SHA256_RE),
      threads: z.number().int().nonnegative(),
      reworkRate: z.number().finite(),
      prevReworkRate: z.number().finite(),
      reverts: z.number().int().nonnegative(),
      /** Commit that introduced the workflow file / prompt template version; null when it could not be found. */
      workflowCommit: z.string().regex(COMMIT_RE).nullable(),
      promptCommit: z.string().regex(COMMIT_RE).nullable(),
    })
    .strict(),
} as const satisfies Record<SignalKind, z.ZodType>;

/** Appends one signal; false when this event was already ingested. Source and taint come from the kind, not from the caller. */
export function recordSignal(ledger: Ledger, kind: SignalKind, eventId: string, payload: unknown, observedAt: number): boolean {
  const { source, taint } = SIGNAL_KINDS[kind];
  const inserted = ledger.insertSignal({
    repo: ledger.repo,
    source,
    kind,
    dedupeKey: `${ledger.repo}:${kind}:${eventId}`,
    taint,
    payload: PAYLOADS[kind].parse(payload),
    observedAt,
  });
  if (inserted) emit("signal_ingested", 1, { kind }, ledger.repo);
  return inserted;
}

function weeklySlot(now: number): string {
  return `w${Math.floor((Math.floor(now / 86_400_000) + 3) / 7)}`;
}

/**
 * Reads each adapter forward from its watermark into the `signals` table. Idempotent: a repeated or overlapping read adds nothing.
 * One adapter failing is reported and does not stop the others; its watermark stays put, so the next poll catches up.
 */
export async function ingestSignals(opts: {
  ledger: Ledger;
  github: GitHubClient;
  defaultBranch: string;
  /** Kinds somebody listens to: the others are not polled. */
  wanted: ReadonlySet<SignalKind>;
  schedules: ReadonlyArray<{ name: string; every: "daily" | "weekly" }>;
  /** The research fetcher (O1), present only when the owner wrote topics. Resolves to how many new results it stored. */
  research?: () => Promise<number>;
  now: number;
  onError: (adapter: string, err: unknown) => void;
  /** The commit that introduced a workflow file or prompt template version, for a regression's revert hint; null when unknown. */
  introducedBy: (kind: "workflow" | "prompt", sha: string) => Promise<string | null>;
}): Promise<void> {
  const { ledger, github, now, wanted } = opts;

  for (const s of opts.schedules) {
    const slot = s.every === "daily" ? formatDayKey(now, ledger.dayTimeZone) : weeklySlot(now);
    recordSignal(ledger, "schedule", `${s.name}:${slot}`, { name: s.name, slot }, now);
  }

  const poll = async (adapter: string, kind: SignalKind, read: (since: number) => Promise<Array<{ at: number; eventId: string; payload: unknown }>>) => {
    if (!wanted.has(kind)) return;
    const mark = ledger.getSignalWatermark(adapter);
    if (mark && now - mark.polledAt < SIGNAL_POLL_MS) return;
    try {
      let watermark = mark?.watermark ?? now - SIGNAL_LOOKBACK_MS;
      for (const ev of await read(watermark)) {
        recordSignal(ledger, kind, ev.eventId, ev.payload, ev.at);
        watermark = Math.max(watermark, ev.at);
      }
      ledger.setSignalWatermark(adapter, watermark, now);
    } catch (err) {
      opts.onError(adapter, err);
    }
  };

  // The telemetry Scout reads only the local Ledger, hourly. Each anomaly is one signal per metric, repo and day.
  const telemetryMark = ledger.getSignalWatermark("telemetry:anomaly");
  if (!telemetryMark || now - telemetryMark.polledAt >= TELEMETRY_SCOUT_EVERY_MS) {
    try {
      for (const a of detectAnomalies(ledger, now)) {
        recordSignal(ledger, "telemetry_anomaly", anomalyEventId(a.metric, now), { ...a, window: "24h", repo: ledger.repo }, now);
      }
      ledger.setSignalWatermark("telemetry:anomaly", now, now);
    } catch (err) {
      opts.onError("telemetry:anomaly", err);
    }
  }

  // Research runs once a day, and only when a rule listens for it. Whatever happens, the next try is tomorrow: the daily fetch cap is not a retry budget.
  if (opts.research && wanted.has("research")) {
    const mark = ledger.getSignalWatermark("research:fetch");
    if (!mark || now - mark.polledAt >= RESEARCH_EVERY_MS) {
      try {
        const stored = await opts.research();
        if (stored > 0) {
          const day = formatDayKey(now, ledger.dayTimeZone);
          recordSignal(ledger, "research", day, { day, results: Math.min(stored, 1000) }, now);
        }
      } catch (err) {
        opts.onError("research:fetch", err);
      } finally {
        ledger.setSignalWatermark("research:fetch", mark?.watermark ?? now, now);
      }
    }
  }

  // The regression watch reads only the local Ledger. Each flagged policy version is one signal, ever.
  const regressionMark = ledger.getSignalWatermark("regression_watch");
  if (!regressionMark || now - regressionMark.polledAt >= TELEMETRY_SCOUT_EVERY_MS) try {
    for (const r of policyRegressions(ledger, now)) {
      const { group: g } = r;
      recordSignal(ledger, "policy_regression", `${g.workflowSha}:${g.promptSha}`, {
        repo: ledger.repo,
        workflowSha: g.workflowSha,
        promptSha: g.promptSha,
        threads: g.threads,
        reworkRate: r.reworkRate,
        prevReworkRate: r.prevReworkRate,
        reverts: g.reverts,
        workflowCommit: await opts.introducedBy("workflow", g.workflowSha),
        promptCommit: await opts.introducedBy("prompt", g.promptSha),
      }, now);
    }
    ledger.setSignalWatermark("regression_watch", now, now);
  } catch (err) {
    opts.onError("regression_watch", err);
  }

  await poll("github:pr_merged", "pr_merged", async (since) =>
    (await github.listMergedPrsSince(since, opts.defaultBranch)).map((p) => ({ at: p.mergedAt, eventId: String(p.number), payload: { number: p.number } })),
  );
  await poll("github:release", "release", async (since) =>
    (await github.listReleasesSince(since)).flatMap((r) => (PAYLOADS.release.safeParse({ tag: r.tag }).success ? [{ at: r.publishedAt, eventId: r.tag, payload: { tag: r.tag } }] : [])),
  );
  await poll("github_advisory:advisory", "advisory", async (since) =>
    (await github.listDependabotAlertsSince(since)).map((a) => ({
      at: a.createdAt,
      eventId: String(a.number),
      payload: { number: a.number, severity: a.severity, ghsaId: a.ghsaId },
    })),
  );
}

/** The kinds this repo has a rule for: adapters nobody listens to are not polled. */
export function wantedKinds(cfg: SignalsConfig, repo: string): Set<SignalKind> {
  return new Set(cfg.rules.filter((r) => appliesToRepo(r, repo)).map((r) => r.on));
}

function appliesToRepo(rule: SignalRule, repo: string): boolean {
  return rule.repo === undefined || rule.repo.toLowerCase() === repo.toLowerCase();
}

/** What the reconciler can do for a rule. `deferred` means it provably did not happen yet (a cap elsewhere), so the signal stays pending. */
export interface SignalActions {
  fileIssue(input: { title: string; body: string }): Promise<number>;
  runScout(input: { scout: string; pitchOnly: boolean }): Promise<"ran" | "deferred" | "rejected">;
}

function ruleMatches(rule: SignalRule, sig: { kind: string; payload: unknown }): boolean {
  if (rule.on !== sig.kind) return false;
  if (rule.schedule !== undefined) return (sig.payload as { name?: unknown }).name === rule.schedule;
  return true;
}

function issueBody(rule: SignalRule & { do: { action: "file_issue" } }, sig: { kind: string; taint: string; payload: unknown; dedupeKey: string }): string {
  return [
    `Filed by the signal rule \`${rule.name}\` (not by a person). Signal \`${sig.kind}\` (${sig.taint}): \`${JSON.stringify(sig.payload)}\`.`,
    "",
    `Suggested class: \`${rule.do.class}\`. Nothing starts until you apply \`ready-for-agent\` yourself.`,
    "",
    `<!-- archangel:signal ${sig.dedupeKey} -->`,
  ].join("\n");
}

/**
 * Level-triggered convergence: every recent signal that matches a rule and has no claim for that rule version gets its action,
 * once. Over-cap signals stay pending and are retried next tick (until they age out). The claim row is written before acting, so
 * a crash can lose an action but never repeat one. At most one Scout run per call, since a run takes minutes.
 */
export async function convergeSignals(opts: {
  cfg: SignalsConfig;
  ledger: Ledger;
  actions: SignalActions;
  /** False while Scouts are disabled or the factory is busy: Scout actions wait. */
  canRunScouts: boolean;
  now: number;
}): Promise<void> {
  const { cfg, ledger, actions, now } = opts;
  const repo = ledger.repo;
  const signals = ledger.listSignals(now - SIGNAL_LOOKBACK_MS);
  let ranScout = false;

  for (const rule of cfg.rules) {
    if (!appliesToRepo(rule, repo)) continue;
    const key = ruleKey(rule);
    for (const sig of signals) {
      if (!ruleMatches(rule, sig) || ledger.hasSignalAction(sig.id, key)) continue;
      if (ledger.countSignalActionsToday(now) >= cfg.maxActionsPerDay) return;
      if (ledger.countSignalActionsToday(now, rule.name) >= rule.maxPerDay) break;

      if (!actionAllowed(sig.taint, rule.do.action)) {
        ledger.claimSignalAction(sig.id, key, rule.name, "rejected", now);
        ledger.appendAudit("signal/rejected_taint", null, "signals", { rule: rule.name, signal: sig.id, taint: sig.taint, action: rule.do.action }, now);
        continue;
      }
      const runsScout = rule.do.action !== "file_issue";
      if (runsScout && (!opts.canRunScouts || ranScout)) continue;
      if (!ledger.claimSignalAction(sig.id, key, rule.name, "claimed", now)) continue;

      try {
        let outcome: string;
        let detail: string | null = null;
        if (rule.do.action === "file_issue") {
          const number = await actions.fileIssue({ title: `${rule.do.title} (${sig.kind} ${refOf(sig.payload)})`, body: issueBody({ ...rule, do: rule.do }, sig) });
          outcome = "done";
          detail = `issue #${number}`;
        } else {
          ranScout = true;
          const r = await actions.runScout({ scout: rule.do.scout, pitchOnly: rule.do.action === "run_pitch" });
          if (r === "deferred") {
            ledger.releaseSignalAction(sig.id, key);
            continue;
          }
          outcome = r === "ran" ? "done" : "rejected";
        }
        ledger.finishSignalAction(sig.id, key, outcome, detail);
        emit("signal_action", 1, { action: rule.do.action, outcome: outcome === "done" ? "done" : "rejected" }, repo);
        ledger.appendAudit("signal/actioned", null, "signals", { rule: rule.name, signal: sig.id, outcome, detail }, now);
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        ledger.finishSignalAction(sig.id, key, "failed", msg);
        emit("signal_action", 1, { action: rule.do.action, outcome: "failed" }, repo);
        ledger.appendAudit("signal/failed", null, "signals", { rule: rule.name, signal: sig.id, error: msg }, now);
      }
    }
  }
}

function refOf(payload: unknown): string {
  const p = payload as Record<string, unknown>;
  return String(p.number ?? p.tag ?? p.slot ?? p.metric);
}
