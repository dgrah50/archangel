import { z } from "zod";
import { TRUSTED_CHECK_APP_SLUG, dedupeChecksByLatestId, type CheckStatus } from "./blockers.js";

export const AttemptKindSchema = z.enum(["implement", "revise", "rebase"]);
export type AttemptKind = z.infer<typeof AttemptKindSchema>;

export const ModeSchema = z.enum(["autonomous", "advisory"]);
export type Mode = z.infer<typeof ModeSchema>;

export type Control = "run" | "paused" | "stopped";

export const PrRefSchema = z.object({
  prNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  baseSha: z.string().min(1),
});
export type PrRef = z.infer<typeof PrRefSchema>;

export const ResumeTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued") }),
  z.object({
    kind: z.literal("awaiting_gate"),
    prNumber: z.number().int().positive(),
    headSha: z.string().min(1),
    baseSha: z.string().min(1),
  }),
]);
export type ResumeTarget = z.infer<typeof ResumeTargetSchema>;

export const EscalationCodeSchema = z.enum([
  "body_changed",
  "already_fixed",
  "broker_policy_failed",
  "gate_failed",
  "gate_timeout",
  "gate_untrusted",
  "review_vetoed",
  "revision_no_change",
  "existing_test_conflict",
  "review_outage",
  "merge_conflict",
  "attempt_timeout",
  "attempt_failed",
  "max_attempts",
  "dependency_unmet",
]);
export type EscalationCode = z.infer<typeof EscalationCodeSchema>;

export const DoneOutcomeSchema = z.enum([
  "merged",
  "owner_merged",
  "pr_closed",
  "reverted",
  "abandoned",
]);
export type DoneOutcome = z.infer<typeof DoneOutcomeSchema>;

export const PhaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued") }),
  z.object({
    kind: z.literal("working"),
    attemptId: z.number().int().positive(),
    attempt: AttemptKindSchema,
    fromSha: z.string().min(1),
    resumeTo: ResumeTargetSchema,
    prNumber: z.number().int().positive().nullable().optional(),
  }),
  z.object({
    kind: z.literal("awaiting_gate"),
    prNumber: z.number().int().positive(),
    headSha: z.string().min(1),
    baseSha: z.string().min(1),
    since: z.number().int(),
    nudgedAt: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("reviewing"),
    prNumber: z.number().int().positive(),
    headSha: z.string().min(1),
    baseSha: z.string().min(1),
    outageSince: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("landing"),
    prNumber: z.number().int().positive(),
    headSha: z.string().min(1),
    baseSha: z.string().min(1),
  }),
  z.object({
    kind: z.literal("shadow_ready"),
    prNumber: z.number().int().positive(),
    headSha: z.string().min(1),
    baseSha: z.string().min(1),
    verdictId: z.number().int().positive().nullable(),
  }),
  z.object({
    kind: z.literal("needs_you"),
    code: EscalationCodeSchema,
    reason: z.string().min(1),
    resumeTo: ResumeTargetSchema,
    prNumber: z.number().int().positive().nullable().optional(),
    headSha: z.string().min(1).nullable().optional(),
  }),
  z.object({
    kind: z.literal("owner_driving"),
    paseoAgentId: z.string().nullable(),
    paseoWorkspaceId: z.string().nullable(),
    since: z.number().int(),
    prNumber: z.number().int().positive().nullable(),
    headSha: z.string().min(1).nullable(),
    baseSha: z.string().min(1).nullable(),
  }),
  z.object({
    kind: z.literal("done"),
    outcome: DoneOutcomeSchema,
    mergeId: z.number().int().positive().optional(),
    prNumber: z.number().int().positive().nullable().optional(),
    headSha: z.string().min(1).nullable().optional(),
  }),
]);
export type Phase = z.infer<typeof PhaseSchema>;
export type PhaseKind = Phase["kind"];

declare const VALIDATED_PHASE: unique symbol;
export type ValidatedPhase = Phase & { readonly [VALIDATED_PHASE]: true };
const validated = (phase: Phase): ValidatedPhase => phase as ValidatedPhase;

export const MainWatchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("watching"), since: z.number().int() }),
  z.object({
    kind: z.literal("rerun_requested"),
    runIds: z.array(z.number().int().positive()),
    at: z.number().int(),
  }),
  z.object({ kind: z.literal("green") }),
  z.object({ kind: z.literal("timed_out"), at: z.number().int() }),
  z.object({
    kind: z.literal("red"),
    revertPrNumber: z.number().int().positive().nullable(),
    escalated: z.boolean(),
  }),
]);
export type MainWatch = z.infer<typeof MainWatchSchema>;

export const OutboxEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add_label"), issueNumber: z.number().int(), label: z.string().min(1) }),
  z.object({ kind: z.literal("remove_label"), issueNumber: z.number().int(), label: z.string().min(1) }),
  z.object({
    kind: z.literal("notify_needs_you"),
    issueNumber: z.number().int().nullable(),
    title: z.string(),
    reason: z.string(),
    code: EscalationCodeSchema,
  }),
]);
export type OutboxEffect = z.infer<typeof OutboxEffectSchema>;

export const OUTBOX_STATES = ["pending", "retrying", "dead_letter"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];
export const OUTBOX_MAX_ATTEMPTS = 10;
export const OUTBOX_BACKOFF_BASE_MS = 30_000;
export const OUTBOX_BACKOFF_MAX_MS = 3_600_000;

export type MachineEvent =
  | { t: "start_working"; attemptId: number; attempt: AttemptKind; fromSha: string; prNumber?: number | null }
  | { t: "attempt_pushed"; pr: PrRef; now: number }
  | { t: "attempt_aborted"; cause: "timeout" | "control" | "handoff"; now: number }
  | { t: "attempt_failed"; code: EscalationCode; reason: string }
  | { t: "gate_passed" }
  | { t: "head_moved"; pr: PrRef; now: number }
  | { t: "review_outage"; now: number }
  | { t: "reviews_approved" }
  | { t: "shadow_recorded"; verdictId: number | null }
  | { t: "landed"; mergeId: number }
  | { t: "pr_observed"; status: "merged" | "closed"; mergeId?: number }
  | { t: "escalate"; code: EscalationCode; reason: string }
  | { t: "owner_retry"; now: number }
  | { t: "factory_retry"; now: number }
  | { t: "owner_abandon" }
  | { t: "handoff_started"; paseoAgentId: string | null; paseoWorkspaceId: string | null; now: number }
  | { t: "paseo_attached"; paseoAgentId: string | null; paseoWorkspaceId: string | null }
  | { t: "owner_resume"; pr: PrRef | null; now: number }
  | { t: "restart_recovered"; now: number };

export type StepResult =
  | { ok: true; next: ValidatedPhase; nextMode?: Mode; effects: OutboxEffect[] }
  | { ok: false; reject: string };

export function deriveControl(
  labels: Iterable<string>,
  cfgLabels: { stop: string; paused: string },
): Control {
  const set = new Set(labels);
  if (set.has(cfgLabels.stop)) return "stopped";
  if (set.has(cfgLabels.paused)) return "paused";
  return "run";
}

export function extractPrFromPhase(phase: Phase): PrRef | null {
  switch (phase.kind) {
    case "awaiting_gate":
    case "reviewing":
    case "landing":
    case "shadow_ready":
      return { prNumber: phase.prNumber, headSha: phase.headSha, baseSha: phase.baseSha };
    case "needs_you":
      return phase.resumeTo.kind === "awaiting_gate"
        ? {
            prNumber: phase.resumeTo.prNumber,
            headSha: phase.resumeTo.headSha,
            baseSha: phase.resumeTo.baseSha,
          }
        : null;
    case "owner_driving":
      return phase.prNumber && phase.headSha && phase.baseSha
        ? { prNumber: phase.prNumber, headSha: phase.headSha, baseSha: phase.baseSha }
        : null;
    default:
      return null;
  }
}

export function toResumeTarget(phase: Phase): ResumeTarget {
  const pr = extractPrFromPhase(phase);
  if (pr) {
    return { kind: "awaiting_gate", ...pr };
  }
  return { kind: "queued" };
}

export function stepPhase(
  phase: Phase,
  mode: Mode,
  ev: MachineEvent,
  meta: { issueNumber: number; title: string; needsYouLabel: string },
): StepResult {
  const ok = (next: Phase, effects: OutboxEffect[] = [], nextMode?: Mode): StepResult =>
    nextMode ? { ok: true, next: validated(next), nextMode, effects } : { ok: true, next: validated(next), effects };

  if (phase.kind === "done") {
    return { ok: false, reject: `Cannot apply ${ev.t} to terminal phase done(${phase.outcome})` };
  }

  if (ev.t === "pr_observed") {
    const outcome: DoneOutcome = ev.status === "merged" ? "owner_merged" : "pr_closed";
    const pr = extractPrFromPhase(phase);
    return ok({
      kind: "done",
      outcome,
      mergeId: ev.mergeId,
      prNumber: pr?.prNumber ?? null,
      headSha: pr?.headSha ?? null,
    });
  }

  if (ev.t === "owner_abandon") {
    const pr = extractPrFromPhase(phase);
    return ok({
      kind: "done",
      outcome: "abandoned",
      prNumber: pr?.prNumber ?? null,
      headSha: pr?.headSha ?? null,
    });
  }

  if (ev.t === "restart_recovered") {
    if (phase.kind !== "working") {
      return { ok: false, reject: `restart_recovered only applies to working, not ${phase.kind}` };
    }
    if (phase.resumeTo.kind === "awaiting_gate") {
      return ok({
        kind: "awaiting_gate",
        prNumber: phase.resumeTo.prNumber,
        headSha: phase.resumeTo.headSha,
        baseSha: phase.resumeTo.baseSha,
        since: ev.now,
        nudgedAt: null,
      });
    }
    return ok({ kind: "queued" });
  }

  if (ev.t === "handoff_started") {
    const pr = extractPrFromPhase(phase);
    return ok(
      {
        kind: "owner_driving",
        paseoAgentId: ev.paseoAgentId,
        paseoWorkspaceId: ev.paseoWorkspaceId,
        since: ev.now,
        prNumber: pr?.prNumber ?? ("prNumber" in phase ? (phase.prNumber ?? null) : null),
        headSha: pr?.headSha ?? ("headSha" in phase ? (phase.headSha ?? null) : null),
        baseSha: pr?.baseSha ?? null,
      },
      [],
      "advisory",
    );
  }

  if (ev.t === "escalate") {
    if (phase.kind === "owner_driving" || phase.kind === "needs_you") {
      return { ok: false, reject: `Cannot escalate from ${phase.kind}` };
    }
    const pr = extractPrFromPhase(phase);
    return ok(
      {
        kind: "needs_you",
        code: ev.code,
        reason: ev.reason,
        resumeTo: toResumeTarget(phase),
        prNumber: pr?.prNumber ?? ("prNumber" in phase ? (phase.prNumber ?? null) : null),
        headSha: pr?.headSha ?? null,
      },
      [
        { kind: "add_label", issueNumber: meta.issueNumber, label: meta.needsYouLabel },
        {
          kind: "notify_needs_you",
          issueNumber: meta.issueNumber,
          title: meta.title,
          reason: ev.reason,
          code: ev.code,
        },
      ],
    );
  }

  if (ev.t === "start_working") {
    if (mode === "advisory") {
      return { ok: false, reject: `Advisory mode forbids starting ${ev.attempt} attempt` };
    }
    if (!["queued", "awaiting_gate", "reviewing", "landing"].includes(phase.kind)) {
      return { ok: false, reject: `Cannot start working from ${phase.kind}` };
    }
    return ok({
      kind: "working",
      attemptId: ev.attemptId,
      attempt: ev.attempt,
      fromSha: ev.fromSha,
      resumeTo: toResumeTarget(phase),
      prNumber: ev.prNumber ?? extractPrFromPhase(phase)?.prNumber ?? null,
    });
  }

  switch (phase.kind) {
    case "working": {
      if (ev.t === "attempt_pushed") {
        return ok({
          kind: "awaiting_gate",
          prNumber: ev.pr.prNumber,
          headSha: ev.pr.headSha,
          baseSha: ev.pr.baseSha,
          since: ev.now,
          nudgedAt: null,
        });
      }
      if (ev.t === "attempt_aborted") {
        if (ev.cause === "timeout") {
          return ok(
            {
              kind: "needs_you",
              code: "attempt_timeout",
              reason: `Attempt (${phase.attempt}) timed out before finishing`,
              resumeTo: phase.resumeTo,
              prNumber: phase.prNumber ?? null,
              headSha: phase.resumeTo.kind === "awaiting_gate" ? phase.resumeTo.headSha : null,
            },
            [
              { kind: "add_label", issueNumber: meta.issueNumber, label: meta.needsYouLabel },
              {
                kind: "notify_needs_you",
                issueNumber: meta.issueNumber,
                title: meta.title,
                reason: `Attempt (${phase.attempt}) timed out`,
                code: "attempt_timeout",
              },
            ],
          );
        }
        if (phase.resumeTo.kind === "awaiting_gate") {
          return ok({
            kind: "awaiting_gate",
            prNumber: phase.resumeTo.prNumber,
            headSha: phase.resumeTo.headSha,
            baseSha: phase.resumeTo.baseSha,
            since: ev.now,
            nudgedAt: null,
          });
        }
        return ok({ kind: "queued" });
      }
      if (ev.t === "attempt_failed") {
        return ok(
          {
            kind: "needs_you",
            code: ev.code,
            reason: ev.reason,
            resumeTo: phase.resumeTo,
            prNumber: phase.prNumber ?? null,
            headSha: phase.resumeTo.kind === "awaiting_gate" ? phase.resumeTo.headSha : null,
          },
          [
            { kind: "add_label", issueNumber: meta.issueNumber, label: meta.needsYouLabel },
            {
              kind: "notify_needs_you",
              issueNumber: meta.issueNumber,
              title: meta.title,
              reason: ev.reason,
              code: ev.code,
            },
          ],
        );
      }
      return { ok: false, reject: `Event ${ev.t} not allowed in working` };
    }

    case "awaiting_gate": {
      if (ev.t === "head_moved") {
        return ok({
          kind: "awaiting_gate",
          prNumber: ev.pr.prNumber,
          headSha: ev.pr.headSha,
          baseSha: ev.pr.baseSha,
          since: ev.now,
          nudgedAt: null,
        });
      }
      if (ev.t === "gate_passed") {
        return ok({
          kind: "reviewing",
          prNumber: phase.prNumber,
          headSha: phase.headSha,
          baseSha: phase.baseSha,
          outageSince: null,
        });
      }
      return { ok: false, reject: `Event ${ev.t} not allowed in awaiting_gate` };
    }

    case "reviewing": {
      if (ev.t === "head_moved") {
        return ok({
          kind: "awaiting_gate",
          prNumber: ev.pr.prNumber,
          headSha: ev.pr.headSha,
          baseSha: ev.pr.baseSha,
          since: ev.now,
          nudgedAt: null,
        });
      }
      if (ev.t === "review_outage") {
        return ok({ ...phase, outageSince: phase.outageSince ?? ev.now });
      }
      if (ev.t === "reviews_approved") {
        return ok({
          kind: "landing",
          prNumber: phase.prNumber,
          headSha: phase.headSha,
          baseSha: phase.baseSha,
        });
      }
      return { ok: false, reject: `Event ${ev.t} not allowed in reviewing` };
    }

    case "landing": {
      if (ev.t === "head_moved") {
        return ok({
          kind: "awaiting_gate",
          prNumber: ev.pr.prNumber,
          headSha: ev.pr.headSha,
          baseSha: ev.pr.baseSha,
          since: ev.now,
          nudgedAt: null,
        });
      }
      if (ev.t === "shadow_recorded") {
        return ok({
          kind: "shadow_ready",
          prNumber: phase.prNumber,
          headSha: phase.headSha,
          baseSha: phase.baseSha,
          verdictId: ev.verdictId,
        });
      }
      if (ev.t === "landed") {
        return ok({
          kind: "done",
          outcome: "merged",
          mergeId: ev.mergeId,
          prNumber: phase.prNumber,
          headSha: phase.headSha,
        });
      }
      return { ok: false, reject: `Event ${ev.t} not allowed in landing` };
    }

    case "shadow_ready": {
      if (ev.t === "head_moved") {
        return ok({
          kind: "awaiting_gate",
          prNumber: ev.pr.prNumber,
          headSha: ev.pr.headSha,
          baseSha: ev.pr.baseSha,
          since: ev.now,
          nudgedAt: null,
        });
      }
      return { ok: false, reject: `Event ${ev.t} not allowed in shadow_ready` };
    }

    case "needs_you": {
      if (ev.t === "owner_retry") {
        const nextPhase: Phase =
          phase.resumeTo.kind === "awaiting_gate"
            ? {
                kind: "awaiting_gate",
                prNumber: phase.resumeTo.prNumber,
                headSha: phase.resumeTo.headSha,
                baseSha: phase.resumeTo.baseSha,
                since: ev.now,
                nudgedAt: null,
              }
            : { kind: "queued" };
        return ok(nextPhase, [{ kind: "remove_label", issueNumber: meta.issueNumber, label: meta.needsYouLabel }]);
      }
      if (ev.t === "factory_retry") {
        return ok(
          phase.resumeTo.kind === "awaiting_gate"
            ? { kind: "awaiting_gate", prNumber: phase.resumeTo.prNumber, headSha: phase.resumeTo.headSha, baseSha: phase.resumeTo.baseSha, since: ev.now, nudgedAt: null }
            : { kind: "queued" },
        );
      }
      return { ok: false, reject: `Event ${ev.t} not allowed in needs_you` };
    }

    case "owner_driving": {
      if (ev.t === "paseo_attached") {
        return ok({
          ...phase,
          paseoAgentId: ev.paseoAgentId,
          paseoWorkspaceId: ev.paseoWorkspaceId,
        });
      }
      if (ev.t === "owner_resume") {
        if (ev.pr) {
          return ok(
            {
              kind: "awaiting_gate",
              prNumber: ev.pr.prNumber,
              headSha: ev.pr.headSha,
              baseSha: ev.pr.baseSha,
              since: ev.now,
              nudgedAt: null,
            },
            [{ kind: "remove_label", issueNumber: meta.issueNumber, label: meta.needsYouLabel }],
            "advisory",
          );
        }
        return ok(
          { kind: "queued" },
          [{ kind: "remove_label", issueNumber: meta.issueNumber, label: meta.needsYouLabel }],
          "advisory",
        );
      }
      return { ok: false, reject: `Event ${ev.t} not allowed in owner_driving` };
    }

    case "queued":
      return { ok: false, reject: `Event ${ev.t} not allowed in queued` };
  }
}

export type GateClassification =
  | { status: "missing_grace"; missing: string[] }
  | { status: "pending"; pending: string[] }
  | { status: "timeout"; detail: string }
  | { status: "untrusted"; names: string[] }
  | { status: "failed"; failed: Array<{ name: string; conclusion: string }> }
  | { status: "green" };

export function classifyGate(input: {
  requiredChecks: string[];
  checks: Array<CheckStatus & { id?: number }>;
  since: number;
  now: number;
  graceMs: number;
  timeoutMs: number;
}): GateClassification {
  const byName = dedupeChecksByLatestId(input.checks);

  const waitMs = input.now - input.since;
  const missing: string[] = [];
  const pending: string[] = [];
  const untrusted: string[] = [];
  const failed: Array<{ name: string; conclusion: string }> = [];

  for (const req of input.requiredChecks) {
    const run = byName.get(req);
    if (!run) {
      missing.push(req);
      continue;
    }
    if (run.appSlug !== TRUSTED_CHECK_APP_SLUG) {
      untrusted.push(`${req} (app=${run.appSlug ?? "missing"})`);
      continue;
    }
    if (run.status !== "completed") {
      pending.push(req);
      continue;
    }
    if (run.conclusion !== "success") {
      failed.push({ name: req, conclusion: run.conclusion ?? "unknown" });
    }
  }

  if (untrusted.length > 0) {
    return { status: "untrusted", names: untrusted };
  }
  const observed = () =>
    input.requiredChecks
      .map((req) => {
        const run = byName.get(req);
        return `${req}=${run ? (run.status === "completed" ? (run.conclusion ?? "unknown") : run.status) : "missing"}`;
      })
      .join(", ");
  if (missing.length > 0) {
    if (waitMs > input.graceMs) {
      return {
        status: "timeout",
        detail: `Required checks never appeared within ${Math.round(input.graceMs / 60_000)} min of the head SHA: ${missing.join(", ")}. Observed: ${observed()}`,
      };
    }
    return { status: "missing_grace", missing };
  }
  if (pending.length > 0) {
    if (waitMs > input.timeoutMs) {
      return {
        status: "timeout",
        detail: `Required checks still pending after ${Math.round(input.timeoutMs / 60_000)} min: ${pending.join(", ")}. Observed: ${observed()}`,
      };
    }
    return { status: "pending", pending };
  }
  if (failed.length > 0) {
    return { status: "failed", failed };
  }
  return { status: "green" };
}
