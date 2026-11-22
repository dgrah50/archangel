---
name: verify-state-machines
description: "Run the explicit-state BFS model checker for Archangel's Thread, Handoff/Daemon Lock, and Pitch state machines. Use whenever editing src/core/thread-machine.ts, src/core/command-machine.ts, src/core/pitch-machine.ts, src/core/reconciler.ts (owner retry, attempt lifecycle, outbox), src/handoff/paseo.ts, or src/ledger/store.ts (daemon lock, CAS transitions, finishAttempt)."
---

# Verify state machines

Run exhaustive BFS model checks over Archangel's Thread, Handoff/Lock, and Pitch concurrency models and verify that 10 seeded past-bug mutants still fail with counterexamples.

## Coverage record

Last confirmed sync commit: `b5d2e6f`

Covered production files and functions:
- `src/core/thread-machine.ts`: `stepPhase` (executed directly by the checker)
- `src/core/command-machine.ts`: `stepCommand` (executed directly by the checker)
- `src/core/pitch-machine.ts`: `stepPitch`, `isUndecided`, `countsAsPromoted`, `promotedSlicesOf` (executed directly by the checker)
- `src/ledger/store.ts`: `transition`, `finishAttempt`, `acquireDaemonLock`, `releaseDaemonLock`, `stepCommandState`, `sweepStaleWorkingRuns` (modeled actions)
- `src/core/reconciler.ts`: `applyMachineEvent`, `ownerRetry`, `executeAttemptTask`, `reconcileThread` `needs_you` label check (modeled actions)
- `src/handoff/paseo.ts`: `handoffThreadToPaseo`, `resumeThreadFromPaseo` (modeled actions)

Before finishing a change to any file above, check `git log b5d2e6f..HEAD -- src/core/thread-machine.ts src/core/command-machine.ts src/core/pitch-machine.ts src/ledger/store.ts src/core/reconciler.ts src/handoff/paseo.ts`. If any modeled step changed, update `formal/check.ts` so every modeled step matches one indivisible step in production code, rerun the check, and advance the sync commit above.

## Properties and harms

- **AdvisoryNeverWorks.** A Thread in `advisory` mode never enters `working`. A break lets the factory force-push over owner commits during or after Paseo handoff.
- **TerminalMonotonic.** A Thread in `done` never leaves `done` or changes `outcome`. A break resurrects merged or closed PRs.
- **OwnerExitAlwaysAvailable.** Every reachable non-`done` phase exits cleanly to `done` on `owner_abandon` and `pr_observed(merged)`. A break traps a Thread where the owner cannot close or merge it.
- **NoPhantomOwnerRetry.** `retryGrants` equals committed `owner_retry` CAS transitions, and `owner_retry` never fires while `add_label` is still queued in the outbox or when a non-owner removed `needs-you`. A break leaks retry budget or lets strangers resume paused Threads.
- **ControlAbortBudgetNeutral.** A `control` abort never increases net `attemptCount`. A break lets pause/halt labels exhaust a Thread's attempt budget.
- **AttemptSettlesOnce.** Budget settlement count never exceeds finished attempts. A break double-charges spend or rewrites a pushed Attempt when a Recap post fails.
- **RestartOnlySweepsWorking.** `restart_recovered` never mutates `needs_you`, `shadow_ready`, `owner_driving`, or `done`. A break drops escalations or handoff state across daemon restarts.
- **CommandMutualExclusion.** CLI never sees `cancelled` while the daemon claims or completes the same handoff command, and CLI never launches Paseo unless the command is `completed`. A break parks a Thread in `owner_driving` with nobody driving.
- **SingleLockHolder.** Two daemons never hold the lock together, a stale release never deletes a newer daemon's lock, and a corrupt lock row blocks `acquireDaemonLock`. A break causes split-brain daemons pushing the same branch.
- **NoDuplicateSlicePromotion / PartialPitchStaysUndecided / PromotedSlicesMonotonic.** No pitch slice promotes twice, partially promoted pitches stay in `isUndecided`, and close or expiry never drops already-promoted slices. A break duplicates GitHub issues or loses promoted slices.

## How to run

```sh
npm run verify:formal
```

Exit code `0` means all 3 clean models passed with zero violations and all 10 past-bug mutants failed on their expected property.

## Reading a failure

Every failure prints the violated property, plain-English detail, and the shortest action trace from `init`:

1. If a clean model fails after you edited `src/core/*-machine.ts`, you broke a real invariant in production code. Fix the production code unless the product requirement itself changed.
2. If a clean model fails only because you intentionally changed an indivisible step in `src/ledger/store.ts`, `src/core/reconciler.ts`, or `src/handoff/paseo.ts`, confirm whether the real code preserves the property. If yes, update the modeled action in `formal/check.ts` to match the real code and keep the property intact.
3. Never weaken a property to make a failure disappear.

## Scope and bounds

- Bounded to 1 Thread, max 2 attempts, max 1 owner retry, max 1 daemon restart, 2 competing daemons on `daemon_lock`, and a 3-slice pitch.
- Does not verify SQLite file locking on disk, GitHub REST retries, or GitBroker shell commands. Pair with `test/ledger.test.ts` and `test/handoff-commands.test.ts`.
