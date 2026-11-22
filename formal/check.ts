import { stepCommand, type CommandState } from "../src/core/command-machine.js";
import {
  countsAsPromoted,
  isUndecided,
  promotedSlicesOf,
  stepPitch,
  type PitchState,
} from "../src/core/pitch-machine.js";
import { stepPhase, type Mode, type Phase } from "../src/core/thread-machine.js";

interface TraceStep {
  action: string;
  summary: string;
}

interface CheckResult {
  name: string;
  statesExplored: number;
  violation: { property: string; detail: string; trace: TraceStep[] } | null;
}

function bfs<S>(opts: {
  name: string;
  initial: S[];
  key: (s: S) => string;
  summary: (s: S) => string;
  step: (s: S) => Array<{ action: string; next: S; check?: { property: string; ok: boolean; detail: string } }>;
  invariants: Array<{ property: string; check: (s: S) => string | null }>;
  maxStates?: number;
}): CheckResult {
  const maxStates = opts.maxStates ?? 150_000;
  const visited = new Set<string>();
  const queue: Array<{ state: S; trace: TraceStep[] }> = [];

  for (const s of opts.initial) {
    const k = opts.key(s);
    if (visited.has(k)) continue;
    visited.add(k);
    const trace = [{ action: "init", summary: opts.summary(s) }];
    for (const inv of opts.invariants) {
      const err = inv.check(s);
      if (err) return { name: opts.name, statesExplored: visited.size, violation: { property: inv.property, detail: err, trace } };
    }
    queue.push({ state: s, trace });
  }

  let head = 0;
  while (head < queue.length) {
    if (visited.size > maxStates) {
      throw new Error(`${opts.name}: exceeded state bound (${maxStates})`);
    }
    const cur = queue[head++]!;
    for (const edge of opts.step(cur.state)) {
      const nextTrace = [...cur.trace, { action: edge.action, summary: opts.summary(edge.next) }];
      if (edge.check && !edge.check.ok) {
        return {
          name: opts.name,
          statesExplored: visited.size,
          violation: { property: edge.check.property, detail: edge.check.detail, trace: nextTrace },
        };
      }
      for (const inv of opts.invariants) {
        const err = inv.check(edge.next);
        if (err) {
          return {
            name: opts.name,
            statesExplored: visited.size,
            violation: { property: inv.property, detail: err, trace: nextTrace },
          };
        }
      }
      const k = opts.key(edge.next);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push({ state: edge.next, trace: nextTrace });
      }
    }
  }

  return { name: opts.name, statesExplored: visited.size, violation: null };
}

// ============================================================================
// Model 1: Thread + Attempt + Outbox + Control/Owner/Restart Concurrency
// Directly executes src/core/thread-machine.ts stepPhase().
// Bounds: max 2 attempts, max 1 owner retry, max 1 restart, single Thread.
// ============================================================================

interface ThreadMutants {
  /** PR #54 bug: ignore pending outbox add_label when checking missing needs-you label. */
  ignorePendingAddLabel?: boolean;
  /** PR #104 bug: resume when a non-owner removed the needs-you label. */
  skipOwnerRemovalCheck?: boolean;
  /** PR #109 bug: control abort does not refund attemptCount. */
  skipControlAbortRefund?: boolean;
  /** PR #128 bug: finishAttempt settles budget a second time on late Recap error. */
  doubleSettleAttempt?: boolean;
  /** PR #211 bug: grantRetryBudget runs before CAS succeeds. */
  grantBudgetBeforeCas?: boolean;
}

interface ThreadModelState {
  phase: Phase;
  mode: Mode;
  version: number;
  attemptId: number;
  attemptStatus: "none" | "running" | "settled";
  attemptCount: number;
  controlAborts: number;
  budgetSettlements: number;
  attemptsFinished: number;
  retryGrants: number;
  committedRetries: number;
  pendingAddNeedsYou: boolean;
  githubHasNeedsYou: boolean;
  needsYouRemovedBy: "none" | "owner" | "other";
  restarts: number;
  doneOutcome: string | null;
  phantomRetry: boolean;
}

const META = { issueNumber: 1, title: "Bug", needsYouLabel: "needs-you" };
const PR_REF = { prNumber: 10, headSha: "h1", baseSha: "b1" };

function checkThreadModel(name: string, m: ThreadMutants = {}): CheckResult {
  const init: ThreadModelState = {
    phase: { kind: "queued" },
    mode: "autonomous",
    version: 0,
    attemptId: 0,
    attemptStatus: "none",
    attemptCount: 0,
    controlAborts: 0,
    budgetSettlements: 0,
    attemptsFinished: 0,
    retryGrants: 0,
    committedRetries: 0,
    pendingAddNeedsYou: false,
    githubHasNeedsYou: false,
    needsYouRemovedBy: "none",
    restarts: 0,
    doneOutcome: null,
    phantomRetry: false,
  };

  return bfs<ThreadModelState>({
    name,
    initial: [init],
    key: (s) =>
      JSON.stringify([
        s.phase.kind,
        s.phase.kind === "working" ? s.phase.resumeTo.kind : s.phase.kind === "needs_you" ? s.phase.resumeTo.kind : s.phase.kind === "done" ? s.phase.outcome : "",
        s.mode,
        s.attemptStatus,
        s.attemptCount,
        s.budgetSettlements,
        s.attemptsFinished,
        s.retryGrants,
        s.committedRetries,
        s.pendingAddNeedsYou,
        s.githubHasNeedsYou,
        s.needsYouRemovedBy,
        s.restarts,
        s.doneOutcome,
        s.phantomRetry,
      ]),
    summary: (s) =>
      `phase=${s.phase.kind} mode=${s.mode} att=${s.attemptStatus}(n=${s.attemptCount}) settlements=${s.budgetSettlements}/${s.attemptsFinished} retries=${s.retryGrants}/${s.committedRetries} pendingAdd=${s.pendingAddNeedsYou} ghLabel=${s.githubHasNeedsYou}(${s.needsYouRemovedBy})`,
    invariants: [
      {
        property: "AdvisoryNeverWorks",
        check: (s) => (s.mode === "advisory" && s.phase.kind === "working" ? "Thread entered working phase while in advisory mode" : null),
      },
      {
        property: "TerminalMonotonic",
        check: (s) =>
          s.doneOutcome !== null && (s.phase.kind !== "done" || s.phase.outcome !== s.doneOutcome)
            ? `Terminal done(${s.doneOutcome}) changed to ${s.phase.kind}`
            : null,
      },
      {
        property: "NoPhantomOwnerRetry",
        check: (s) => {
          if (s.phantomRetry) return "Owner retry fired while add_label was pending or label was removed by a non-owner";
          if (s.retryGrants !== s.committedRetries) {
            return `retryGrants (${s.retryGrants}) diverged from committed owner retries (${s.committedRetries})`;
          }
          return null;
        },
      },
      {
        property: "ControlAbortBudgetNeutral",
        check: (s) => {
          const maxConsumed = s.attemptsFinished - s.controlAborts + (s.attemptStatus === "running" ? 1 : 0);
          return s.attemptCount > maxConsumed
            ? `attemptCount (${s.attemptCount}) exceeded non-control-aborted attempts (${maxConsumed})`
            : null;
        },
      },
      {
        property: "AttemptSettlesOnce",
        check: (s) =>
          s.budgetSettlements > s.attemptsFinished
            ? `budgetSettlements (${s.budgetSettlements}) exceeded finished attempts (${s.attemptsFinished})`
            : null,
      },
    ],
    step: (s) => {
      const out: Array<{ action: string; next: ThreadModelState; check?: { property: string; ok: boolean; detail: string } }> = [];

      const apply = (
        action: string,
        ev: Parameters<typeof stepPhase>[2],
        patch: (next: ThreadModelState, effects: Array<{ kind: string }>) => void = () => {},
      ) => {
        const res = stepPhase(s.phase, s.mode, ev, META);
        if (!res.ok) return;
        const next: ThreadModelState = {
          ...s,
          phase: res.next,
          mode: res.nextMode ?? s.mode,
          version: s.version + 1,
          doneOutcome: res.next.kind === "done" ? (s.doneOutcome ?? res.next.outcome) : s.doneOutcome,
        };
        for (const eff of res.effects) {
          if (eff.kind === "add_label") next.pendingAddNeedsYou = true;
          if (eff.kind === "remove_label") next.githubHasNeedsYou = false;
        }
        patch(next, res.effects);
        out.push({ action, next });
      };

      // 1. Daemon starts a working attempt (bounded by budget 1 + retryGrants, max 2 total starts).
      if (
        s.attemptStatus !== "running" &&
        s.attemptId < 2 &&
        s.attemptCount < 1 + s.retryGrants &&
        (s.phase.kind === "queued" || s.phase.kind === "awaiting_gate")
      ) {
        const nextId = s.attemptId + 1;
        apply("daemon_start_working", { t: "start_working", attemptId: nextId, attempt: s.phase.kind === "queued" ? "implement" : "revise", fromSha: "b1" }, (n) => {
          n.attemptId = nextId;
          n.attemptStatus = "running";
          n.attemptCount += 1;
        });
      }

      // 2. Worker finishes running attempt: push PR, fail, timeout abort, or control abort.
      if (s.phase.kind === "working" && s.attemptStatus === "running") {
        apply("worker_push_pr", { t: "attempt_pushed", pr: PR_REF, now: 10 }, (n) => {
          n.attemptStatus = "settled";
          n.attemptsFinished += 1;
          n.budgetSettlements += 1;
        });
        apply("worker_fail", { t: "attempt_failed", code: "gate_failed", reason: "red" }, (n) => {
          n.attemptStatus = "settled";
          n.attemptsFinished += 1;
          n.budgetSettlements += 1;
        });
        apply("worker_abort_timeout", { t: "attempt_aborted", cause: "timeout", now: 10 }, (n) => {
          n.attemptStatus = "settled";
          n.attemptsFinished += 1;
          n.budgetSettlements += 1;
        });
        apply("worker_abort_control", { t: "attempt_aborted", cause: "control", now: 10 }, (n) => {
          n.attemptStatus = "settled";
          n.attemptsFinished += 1;
          n.budgetSettlements += 1;
          n.controlAborts += 1;
          if (!m.skipControlAbortRefund) n.attemptCount = Math.max(0, n.attemptCount - 1);
        });
      }

      // 3. Late error handler after worker already pushed and settled (#128).
      if (s.attemptStatus === "settled" && s.phase.kind === "awaiting_gate") {
        const next: ThreadModelState = { ...s };
        if (m.doubleSettleAttempt) {
          next.budgetSettlements += 1;
        }
        out.push({ action: "worker_late_recap_error", next });
      }

      // 4. Outbox delivers pending needs-you add_label (GitHub timeline keeps last unlabeled actor).
      if (s.pendingAddNeedsYou) {
        out.push({
          action: "outbox_deliver_add_label",
          next: { ...s, pendingAddNeedsYou: false, githubHasNeedsYou: true },
        });
      }

      // 5. GitHub label removals in needs_you (owner vs non-owner).
      if (s.phase.kind === "needs_you" && s.githubHasNeedsYou) {
        out.push({
          action: "owner_remove_needs_you_label",
          next: { ...s, githubHasNeedsYou: false, needsYouRemovedBy: "owner" },
        });
        out.push({
          action: "stranger_remove_needs_you_label",
          next: { ...s, githubHasNeedsYou: false, needsYouRemovedBy: "other" },
        });
      }

      // 6. Daemon checks whether missing needs-you label means owner retry (#54, #104).
      if (s.phase.kind === "needs_you" && s.committedRetries < 2 && !s.githubHasNeedsYou) {
        const labelGate = m.ignorePendingAddLabel ? true : !s.pendingAddNeedsYou;
        const actorGate = m.skipOwnerRemovalCheck ? true : s.needsYouRemovedBy === "owner";
        if (labelGate && actorGate) {
          const isPhantom = s.pendingAddNeedsYou || s.needsYouRemovedBy !== "owner";
          apply("daemon_owner_retry_from_label", { t: "owner_retry", now: 20 }, (n) => {
            n.retryGrants += 1;
            n.committedRetries += 1;
            if (isPhantom) n.phantomRetry = true;
          });
        }
      }

      // 7. Concurrent stale-CAS owner retry racing an owner abandon (PR #211).
      if (s.phase.kind === "needs_you" && s.committedRetries < 1) {
        const ab = stepPhase(s.phase, s.mode, { t: "owner_abandon" }, META);
        if (ab.ok) {
          const next: ThreadModelState = {
            ...s,
            phase: ab.next,
            version: s.version + 1,
            doneOutcome: ab.next.kind === "done" ? ab.next.outcome : s.doneOutcome,
            retryGrants: m.grantBudgetBeforeCas ? s.retryGrants + 1 : s.retryGrants,
          };
          out.push({ action: "stale_owner_retry_loses_cas_to_abandon", next });
        }
      }

      // 8. Gate -> Reviewing -> Landing -> Done.
      if (s.phase.kind === "awaiting_gate") apply("gate_passed", { t: "gate_passed" });
      if (s.phase.kind === "reviewing") apply("reviews_approved", { t: "reviews_approved" });
      if (s.phase.kind === "landing") apply("landed", { t: "landed", mergeId: 1 });

      // 9. Handoff to Paseo and resume (always stays advisory).
      if (s.phase.kind !== "done" && s.phase.kind !== "owner_driving" && s.mode === "autonomous") {
        apply("handoff_started", { t: "handoff_started", paseoAgentId: "p1", paseoWorkspaceId: "w1", now: 30 }, (n) => {
          if (n.attemptStatus === "running") {
            n.attemptStatus = "settled";
            n.attemptsFinished += 1;
            n.budgetSettlements += 1;
          }
        });
      }
      if (s.phase.kind === "owner_driving") {
        apply("owner_resume", { t: "owner_resume", pr: PR_REF, now: 40 });
      }

      // 10. Verify advisory mode still blocks start_working directly in stepPhase().
      if (s.mode === "advisory" && s.phase.kind !== "done") {
        const bad = stepPhase(s.phase, s.mode, { t: "start_working", attemptId: 9, attempt: "revise", fromSha: "h1" }, META);
        if (bad.ok) {
          out.push({
            action: "advisory_start_working_accepted",
            next: { ...s, phase: bad.next, version: s.version + 1 },
          });
        }
      }

      // 11. Startup crash recovery: restart_recovered must only recover working phases.
      if (s.restarts < 1 && s.phase.kind !== "done") {
        const rec = stepPhase(s.phase, s.mode, { t: "restart_recovered", now: 50 }, META);
        if (s.phase.kind === "working") {
          if (rec.ok) {
            out.push({
              action: "daemon_restart_sweep",
              next: {
                ...s,
                phase: rec.next,
                version: s.version + 1,
                restarts: s.restarts + 1,
                attemptStatus: s.attemptStatus === "running" ? "settled" : s.attemptStatus,
                attemptsFinished: s.attemptStatus === "running" ? s.attemptsFinished + 1 : s.attemptsFinished,
                budgetSettlements: s.attemptStatus === "running" ? s.budgetSettlements + 1 : s.budgetSettlements,
              },
            });
          }
        } else if (rec.ok) {
          out.push({
            action: "restart_recovered_non_working",
            next: { ...s, phase: rec.next, restarts: s.restarts + 1 },
            check: {
              property: "RestartOnlySweepsWorking",
              ok: false,
              detail: `restart_recovered mutated non-working phase ${s.phase.kind}`,
            },
          });
        }
      }

      // 12. Verify done phase rejects further transitions.
      if (s.phase.kind === "done") {
        for (const ev of [{ t: "owner_abandon" as const }, { t: "start_working" as const, attemptId: 9, attempt: "implement" as const, fromSha: "b1" }]) {
          const bad = stepPhase(s.phase, s.mode, ev, META);
          if (bad.ok) {
            out.push({
              action: `done_accepted_${ev.t}`,
              next: { ...s, phase: bad.next },
            });
          }
        }
      }

      return out;
    },
  });
}

// ============================================================================
// Model 2: CLI <-> Daemon Handoff Command & Daemon Lock Concurrency
// Directly executes src/core/command-machine.ts stepCommand().
// ============================================================================

interface HandoffLockMutants {
  /** PR #129 bug: CLI cancels handoff without CAS against daemon claim. */
  uncasCliCancel?: boolean;
  /** PR #211 bug: releaseDaemonLock deletes without atomic ownership check. */
  nonAtomicLockRelease?: boolean;
  /** PR #211 bug: acquireDaemonLock overwrites a corrupt lock row. */
  overwriteCorruptLock?: boolean;
}

interface HandoffLockState {
  cmd: CommandState;
  cliResult: "waiting" | "cancelled" | "launched" | "failed";
  daemonExecutingHandoff: boolean;
  lockRow: "none" | "d1_fresh" | "d1_stale" | "d2_fresh" | "corrupt";
  d1HasLock: boolean;
  d2HasLock: boolean;
  d1ReadOwnLockBeforePause: boolean;
}

function checkHandoffLockModel(name: string, m: HandoffLockMutants = {}): CheckResult {
  const initial: HandoffLockState[] = [
    {
      cmd: { kind: "pending" },
      cliResult: "waiting",
      daemonExecutingHandoff: false,
      lockRow: "d1_fresh",
      d1HasLock: true,
      d2HasLock: false,
      d1ReadOwnLockBeforePause: false,
    },
    {
      cmd: { kind: "pending" },
      cliResult: "waiting",
      daemonExecutingHandoff: false,
      lockRow: "corrupt",
      d1HasLock: true,
      d2HasLock: false,
      d1ReadOwnLockBeforePause: false,
    },
  ];

  return bfs<HandoffLockState>({
    name,
    initial,
    key: (s) => JSON.stringify([s.cmd.kind, s.cliResult, s.daemonExecutingHandoff, s.lockRow, s.d1HasLock, s.d2HasLock, s.d1ReadOwnLockBeforePause]),
    summary: (s) => `cmd=${s.cmd.kind} cli=${s.cliResult} daemonHandoff=${s.daemonExecutingHandoff} lock=${s.lockRow} d1=${s.d1HasLock} d2=${s.d2HasLock}`,
    invariants: [
      {
        property: "CommandMutualExclusion",
        check: (s) => {
          if (s.cliResult === "cancelled" && (s.daemonExecutingHandoff || s.cmd.kind === "claimed" || s.cmd.kind === "completed")) {
            return `CLI cancelled handoff while daemon had cmd=${s.cmd.kind} executing=${s.daemonExecutingHandoff}`;
          }
          if (s.cliResult === "launched" && s.cmd.kind !== "completed") {
            return `CLI launched Paseo while command state was ${s.cmd.kind}`;
          }
          return null;
        },
      },
      {
        property: "SingleLockHolder",
        check: (s) => {
          if (s.d1HasLock && s.d2HasLock) return "Both d1 and d2 hold the daemon lock simultaneously";
          if (s.d2HasLock && s.lockRow === "none") return "Live daemon d2 had its lock row deleted out from under it";
          return null;
        },
      },
    ],
    step: (s) => {
      const out: Array<{ action: string; next: HandoffLockState }> = [];

      // Daemon claims pending handoff command.
      if (s.d1HasLock && !s.daemonExecutingHandoff && s.cmd.kind === "pending") {
        const res = stepCommand(s.cmd, { t: "claim", at: 1 });
        if (res.ok) {
          out.push({ action: "daemon_claim_command", next: { ...s, cmd: res.next, daemonExecutingHandoff: true } });
        }
      }

      // Daemon completes or fails claimed command.
      if (s.daemonExecutingHandoff && s.cmd.kind === "claimed") {
        const done = stepCommand(s.cmd, { t: "complete", result: { ok: true } });
        if (done.ok) {
          out.push({ action: "daemon_complete_command", next: { ...s, cmd: done.next, daemonExecutingHandoff: false } });
        }
        const fail = stepCommand(s.cmd, { t: "fail", error: "push failed" });
        if (fail.ok) {
          out.push({ action: "daemon_fail_command", next: { ...s, cmd: fail.next, daemonExecutingHandoff: false } });
        }
      }

      // CLI observes command completion / failure.
      if (s.cliResult === "waiting" && s.cmd.kind === "completed") {
        out.push({ action: "cli_launch_paseo", next: { ...s, cliResult: "launched" } });
      }
      if (s.cliResult === "waiting" && s.cmd.kind === "failed") {
        out.push({ action: "cli_observe_failure", next: { ...s, cliResult: "failed" } });
      }

      // CLI timeout attempts cancelCommand.
      if (s.cliResult === "waiting") {
        if (m.uncasCliCancel) {
          out.push({ action: "cli_timeout_cancel_uncas", next: { ...s, cmd: { kind: "cancelled", reason: "timeout" }, cliResult: "cancelled" } });
        } else {
          const cancel = stepCommand(s.cmd, { t: "cancel", reason: "timeout" });
          if (cancel.ok) {
            out.push({ action: "cli_timeout_cancel_cas", next: { ...s, cmd: cancel.next, cliResult: "cancelled" } });
          }
        }
      }

      // Lock stale expiry + d2 takeover + d1 heartbeat/release interleavings.
      if (s.lockRow === "d1_fresh") {
        out.push({ action: "d1_lock_becomes_stale", next: { ...s, lockRow: "d1_stale" } });
        if (m.nonAtomicLockRelease) {
          out.push({ action: "d1_reads_own_lock_before_pause", next: { ...s, d1ReadOwnLockBeforePause: true } });
        }
      }
      if (s.lockRow === "d1_stale" && !s.d2HasLock) {
        // d2 acquires stale lock; d1 loses lock on next heartbeat.
        out.push({ action: "d2_acquires_stale_lock", next: { ...s, lockRow: "d2_fresh", d1HasLock: false, d2HasLock: true } });
      }
      if (s.lockRow === "corrupt" && !s.d2HasLock && m.overwriteCorruptLock) {
        out.push({ action: "d2_overwrites_corrupt_lock", next: { ...s, lockRow: "d2_fresh", d2HasLock: true } });
      }
      if (s.d1ReadOwnLockBeforePause && m.nonAtomicLockRelease) {
        // Non-atomic DELETE FROM system_state WHERE key = 'daemon_lock' runs after d2 acquired!
        out.push({ action: "d1_executes_stale_delete_lock", next: { ...s, lockRow: "none", d1HasLock: false, d1ReadOwnLockBeforePause: false } });
      } else if (s.d1HasLock && (s.lockRow === "d1_fresh" || s.lockRow === "d1_stale")) {
        // Atomic BEGIN IMMEDIATE release: only deletes if row still belongs to d1.
        out.push({ action: "d1_atomic_release_lock", next: { ...s, lockRow: "none", d1HasLock: false } });
      }

      return out;
    },
  });
}

// ============================================================================
// Model 3: Pitch Promotion & Expiry State Machine
// Directly executes src/core/pitch-machine.ts stepPitch() + helpers.
// Bounds: 3-slice pitch, subset promotions, close, decline reason, expiry.
// ============================================================================

interface PitchMutants {
  /** PR #125 bug: partially_promoted omitted from isUndecided(). */
  partialVanishesFromUndecided?: boolean;
  /** PR #156 bug: expiry turns partially_promoted into expired, losing promoted slices. */
  expiryDropsPartialSlices?: boolean;
}

interface PitchModelState {
  state: PitchState;
  everPromoted: number[];
  duplicateAttempted: boolean;
}

function checkPitchModel(name: string, m: PitchMutants = {}): CheckResult {
  const TOTAL = 3;
  const init: PitchModelState = { state: { kind: "open" }, everPromoted: [], duplicateAttempted: false };

  return bfs<PitchModelState>({
    name,
    initial: [init],
    key: (s) => JSON.stringify([s.state, s.everPromoted, s.duplicateAttempted]),
    summary: (s) => `pitch=${s.state.kind}(slices=[${promotedSlicesOf(s.state).join(",")}]) ever=[${s.everPromoted.join(",")}]`,
    invariants: [
      {
        property: "NoDuplicateSlicePromotion",
        check: (s) => (s.duplicateAttempted ? "stepPitch accepted a duplicate slice promotion" : null),
      },
      {
        property: "PartialPitchStaysUndecided",
        check: (s) => {
          if (s.state.kind !== "partially_promoted") return null;
          const undecided = m.partialVanishesFromUndecided ? false : isUndecided(s.state);
          if (!undecided) return "partially_promoted pitch vanished from isUndecided()";
          if (!countsAsPromoted(s.state)) return "partially_promoted pitch failed countsAsPromoted()";
          return null;
        },
      },
      {
        property: "PromotedSlicesMonotonic",
        check: (s) => {
          const cur = promotedSlicesOf(s.state);
          for (const idx of s.everPromoted) {
            if (!cur.includes(idx)) return `Promoted slice ${idx} was lost when pitch entered ${s.state.kind}`;
          }
          if (s.everPromoted.length > 0 && (s.state.kind === "declined" || s.state.kind === "expired")) {
            return `Pitch with promoted slices [${s.everPromoted.join(",")}] ended as ${s.state.kind}`;
          }
          return null;
        },
      },
    ],
    step: (s) => {
      const out: Array<{ action: string; next: PitchModelState }> = [];
      for (const slice of [0, 1, 2]) {
        const res = stepPitch(s.state, { t: "slices_promoted", slices: [slice], total: TOTAL });
        if (res.ok) {
          const dup = s.everPromoted.includes(slice);
          out.push({
            action: `promote_slice_${slice}`,
            next: { state: res.next, everPromoted: [...new Set([...s.everPromoted, slice])].sort((a, b) => a - b), duplicateAttempted: dup },
          });
        }
      }
      const closed = stepPitch(s.state, { t: "closed" });
      if (closed.ok) out.push({ action: "owner_close", next: { ...s, state: closed.next } });

      if (m.expiryDropsPartialSlices && s.state.kind === "partially_promoted") {
        out.push({ action: "bot_expire_buggy", next: { ...s, state: { kind: "expired", expiredAt: 99 } } });
      } else {
        const expired = stepPitch(s.state, { t: "expired", at: 99 });
        if (expired.ok) out.push({ action: "bot_expire", next: { ...s, state: expired.next } });
      }

      const reason = stepPitch(s.state, { t: "decline_reason", reason: "not now" });
      if (reason.ok) out.push({ action: "record_decline_reason", next: { ...s, state: reason.next } });

      return out;
    },
  });
}

function formatTrace(trace: TraceStep[]): string {
  return trace.map((t, i) => `  ${i}. ${t.action} -> ${t.summary}`).join("\n");
}

function main() {
  const cleanChecks: CheckResult[] = [
    checkThreadModel("Thread + Attempt + Outbox + Control/Restart"),
    checkHandoffLockModel("CLI <-> Daemon Handoff + Daemon Lock"),
    checkPitchModel("Pitch Promotion & Expiry"),
  ];

  let failed = false;
  console.log("=== Formal verification (clean models against production transition code) ===");
  for (const r of cleanChecks) {
    if (r.violation) {
      failed = true;
      console.error(`FAIL [${r.name}] ${r.violation.property}: ${r.violation.detail}`);
      console.error(formatTrace(r.violation.trace));
    } else {
      console.log(`PASS [${r.name}] explored ${r.statesExplored} reachable states, 0 violations`);
    }
  }

  const mutants: Array<{ bug: string; expectedProperty: string; run: () => CheckResult }> = [
    { bug: "PR #54 (needs-you missing while add_label still in outbox)", expectedProperty: "NoPhantomOwnerRetry", run: () => checkThreadModel("mutant:#54", { ignorePendingAddLabel: true }) },
    { bug: "PR #104 (non-owner removes needs-you label)", expectedProperty: "NoPhantomOwnerRetry", run: () => checkThreadModel("mutant:#104", { skipOwnerRemovalCheck: true }) },
    { bug: "PR #109 (control abort fails to refund attempt budget)", expectedProperty: "ControlAbortBudgetNeutral", run: () => checkThreadModel("mutant:#109", { skipControlAbortRefund: true }) },
    { bug: "PR #128 (late Recap error settles attempt budget twice)", expectedProperty: "AttemptSettlesOnce", run: () => checkThreadModel("mutant:#128", { doubleSettleAttempt: true }) },
    { bug: "PR #211 (grantRetryBudget before CAS loses race)", expectedProperty: "NoPhantomOwnerRetry", run: () => checkThreadModel("mutant:#211-cas", { grantBudgetBeforeCas: true }) },
    { bug: "PR #129 (CLI cancels handoff without CAS against daemon claim)", expectedProperty: "CommandMutualExclusion", run: () => checkHandoffLockModel("mutant:#129", { uncasCliCancel: true }) },
    { bug: "PR #211 (non-atomic releaseDaemonLock deletes new owner's lock)", expectedProperty: "SingleLockHolder", run: () => checkHandoffLockModel("mutant:#211-lock", { nonAtomicLockRelease: true }) },
    { bug: "PR #211 (acquireDaemonLock overwrites corrupt lock row)", expectedProperty: "SingleLockHolder", run: () => checkHandoffLockModel("mutant:#211-corrupt", { overwriteCorruptLock: true }) },
    { bug: "PR #125 (partially_promoted vanishes from isUndecided)", expectedProperty: "PartialPitchStaysUndecided", run: () => checkPitchModel("mutant:#125", { partialVanishesFromUndecided: true }) },
    { bug: "PR #156 (bot expiry drops already-promoted slices)", expectedProperty: "PromotedSlicesMonotonic", run: () => checkPitchModel("mutant:#156", { expiryDropsPartialSlices: true }) },
  ];

  console.log("\n=== Regression-mutant proofs (each past bug must fail with a counterexample) ===");
  for (const mt of mutants) {
    const res = mt.run();
    if (!res.violation) {
      failed = true;
      console.error(`FAIL [${mt.bug}] mutant PASSED unexpectedly (expected ${mt.expectedProperty})`);
    } else if (res.violation.property !== mt.expectedProperty) {
      failed = true;
      console.error(`FAIL [${mt.bug}] violated ${res.violation.property}, expected ${mt.expectedProperty}`);
    } else {
      console.log(`CAUGHT [${mt.bug}] -> ${res.violation.property} in ${res.violation.trace.length - 1} steps`);
    }
  }

  if (failed) process.exit(1);
}

main();
