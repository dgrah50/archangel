import type { AttemptErrorCategory } from "../ledger/schema.js";
import type { EscalationCode } from "./thread-machine.js";
import type { WorkClass } from "./work-class.js";

/**
 * The only kinds of decision Archangel may put in front of the owner.
 * Anything else the factory must decide (or fail) on its own.
 */
export const DECISION_CLASSES = [
  "credentials",
  "spending",
  "live_infrastructure",
  "irreversible",
  "product_decision",
  "owner_signoff",
] as const;
export type DecisionClass = (typeof DECISION_CLASSES)[number];

export interface EscalationPolicy {
  decisionClass: DecisionClass;
  /** A phrase under about 60 characters for dashboard rows; `recommendation` is the full text. */
  short: string;
  recommendation: string;
}

/**
 * Exhaustive by construction: adding an EscalationCode without a class fails typecheck.
 */
export const ESCALATION_POLICY: Record<EscalationCode, EscalationPolicy> = {
  body_changed: {
    decisionClass: "owner_signoff",
    short: "recommends reading the edited issue body first",
    recommendation:
      "Review the edited issue body. If it is what you want built, remove `needs-you` (or `archangel retry`); otherwise revert the edit.",
  },
  already_fixed: {
    decisionClass: "product_decision",
    short: "recommends confirming main, then closing",
    recommendation:
      "Confirm the bug no longer reproduces on main and close the issue; if it still does, comment with a reproduction and retry.",
  },
  broker_policy_failed: {
    decisionClass: "owner_signoff",
    short: "recommends narrowing the issue or taking it over",
    recommendation:
      "The fix needs protected paths or exceeds diff bounds. Narrow the issue, or take it over with `archangel handoff`.",
  },
  gate_failed: {
    decisionClass: "live_infrastructure",
    short: "recommends reading the Gate output, then retry",
    recommendation:
      "Read the Gate output on the PR. Comment guidance and retry, or close the PR; do not merge without a passing Gate.",
  },
  gate_timeout: {
    decisionClass: "live_infrastructure",
    short: "recommends re-running CI, then retry",
    recommendation:
      "Required checks never finished. Check the workflow run on the PR, fix or re-run CI, then retry.",
  },
  gate_untrusted: {
    decisionClass: "credentials",
    short: "recommends removing that check from requiredChecks",
    recommendation:
      "A required check (named in the reason) was not reported by GitHub Actions, the only source Archangel accepts. If it is a third-party check (a scanner, a deploy preview), remove it from `requiredChecks` in .agents/archangel.json with a PR you merge; if it should be your own workflow's check, verify the repo's Gate workflow. Then retry.",
  },
  review_vetoed: {
    decisionClass: "live_infrastructure",
    short: "recommends reading the findings first",
    recommendation:
      "Read the reviewer findings in the Recap. Comment guidance and retry, merge yourself if the veto is wrong, or close the PR.",
  },
  revision_no_change: {
    decisionClass: "live_infrastructure",
    short: "recommends commenting new guidance, then retry",
    recommendation:
      "The revision came back byte-identical to the previous head: the implementer could not meet the feedback within the rules. Read its summary and the findings, then comment what it should do differently and retry, or close the PR.",
  },
  existing_test_conflict: {
    decisionClass: "product_decision",
    short: "recommends deciding whether the test or issue is right",
    recommendation:
      "The issue contradicts an existing test (named in the reason), and existing tests are immutable for the factory. Decide which behaviour is right: edit the issue to match the test, or change the test yourself; then retry or close.",
  },
  review_outage: {
    decisionClass: "credentials",
    short: "recommends fixing the reviewer named, then retry",
    recommendation:
      "A reviewer could not run, and two independent reviewers are required (the reason says which and why). For a login problem, run `archangel doctor --smoke` and re-login. For a usage limit, wait for it to reset, or add another login for that provider under `accounts` in archangel.yaml. Then retry.",
  },
  merge_conflict: {
    decisionClass: "live_infrastructure",
    short: "recommends retry on a fresh Attempt",
    recommendation:
      "The branch conflicts with main and the automatic rebase failed. Retry for a fresh Attempt, or resolve it with `archangel handoff`.",
  },
  attempt_timeout: {
    decisionClass: "spending",
    short: "recommends narrowing the issue, then retry",
    recommendation: "The Attempt used its whole time budget. Narrow the issue or comment a hint, then retry.",
  },
  attempt_failed: {
    decisionClass: "product_decision",
    short: "recommends commenting what it missed, then retry",
    recommendation:
      "The implementer could not produce a valid fix. If the reason names a cause (login, CLI, permissions, network, context size), fix that first. Otherwise read its summary, comment what it missed (your comment reaches the next Attempt), then retry.",
  },
  dependency_unmet: {
    decisionClass: "owner_signoff",
    short: "recommends retrying the slice on its own",
    recommendation:
      "The slice this one was chained after ended without merging (closed or abandoned). Retry to run this slice on its own, or close it if it only made sense after that one.",
  },
  plan_unresolved: {
    decisionClass: "product_decision",
    short: "recommends writing the plan yourself, or retry",
    recommendation:
      "The factory could not produce a plan you approved (it failed, or the re-plan budget is used up). Comment what the plan must say and retry for a fresh budget, or close the issue and take the feature yourself.",
  },
  max_attempts: {
    decisionClass: "spending",
    short: "recommends retry for one more Attempt, or close",
    recommendation: "The Thread has used its Attempts. A retry grants one more Attempt (and one more revision); comment what it should do differently first, or close the issue if it is not worth more runs.",
  },
};

/** What the owner should do about a failed Attempt whose cause was recorded; categories not listed have no cause-specific advice. */
export const ATTEMPT_FAILURE_ADVICE: Partial<Record<AttemptErrorCategory, string>> = {
  provider_network: "The CLI lost its connection twice; check the network, then retry.",
  auth: "A CLI login is invalid or expired: re-login the account named in the reason (its CLI's login, with that account's config dir), then retry.",
  permission_denied: "The CLI denied a tool in headless mode and did no work: check that provider's permission flags, then retry.",
  cli_missing: "The provider CLI is not installed or not on PATH: install it or run `archangel doctor`, then retry.",
  model_unavailable: "The login cannot run the model named in the reason: change or remove that entry's `model` under `chains` in archangel.yaml (no `model` uses the CLI's default), restart the daemon, then retry.",
  context_overflow: "The prompt exceeded the model's context: narrow the issue, then retry.",
  setup_failed: "The repo's `.agents/setup` script failed (see the reason): fix it on the default branch (`archangel doctor --verify-setup` runs it), then retry.",
};

/** One-tap answers the owner can post as a comment on the Thread's issue or PR. */
export const OWNER_COMMANDS_LINE =
  "Reply `/archangel retry` with a hint, `/archangel close`, or `/archangel handoff`.";

/**
 * Decision class of a failed Attempt by its recorded cause; causes not listed stay `attempt_failed`'s own class. The listed causes
 * are infrastructure: the implementer never got to work on the issue.
 */
const ATTEMPT_FAILURE_CLASS: Partial<Record<AttemptErrorCategory, DecisionClass>> = {
  auth: "credentials",
  cli_missing: "credentials",
  model_unavailable: "credentials",
  permission_denied: "credentials",
  provider_network: "live_infrastructure",
  setup_failed: "live_infrastructure",
  // Never put to the owner per Thread (the Thread waits for a cooldown to end); listed so the failed run is not charged to the Thread.
  quota: "spending",
};

/** True when the Attempt failed before the implementer could work (login, CLI, model, network, quota, repo setup): it does not count against the Thread's Attempt budget. */
export function isInfrastructureFailure(cause: AttemptErrorCategory | undefined): boolean {
  return cause !== undefined && cause in ATTEMPT_FAILURE_CLASS;
}

export function describeEscalation(code: EscalationCode, workClass: WorkClass = "bugfix", cause?: AttemptErrorCategory): EscalationPolicy {
  const base = ESCALATION_POLICY[code];
  const policy = cause
    ? { ...base, decisionClass: ATTEMPT_FAILURE_CLASS[cause] ?? base.decisionClass, recommendation: ATTEMPT_FAILURE_ADVICE[cause] ?? base.recommendation }
    : base;
  const feature = workClass !== "bugfix" ? ` This is a ${workClass} Thread: the owner merges it.` : "";
  return { ...policy, recommendation: `${policy.recommendation}${feature} ${OWNER_COMMANDS_LINE}` };
}

export function formatDecisionClass(c: DecisionClass): string {
  return c.replace(/_/g, " ");
}

/** Escalations raised by project-level monitors (autonomy cap, post-merge main) rather than by a Thread. */
export const MAIN_ESCALATION_POLICY = {
  correction_draft_unlanded: {
    decisionClass: "owner_signoff",
    short: "recommends reading the draft, apply it or ignore",
    recommendation:
      "Archangel drafted a change for a repeated correction but its offline eval did not pass (or had too little data), so no PR was opened. Read the draft; apply it yourself, or ignore it. Nothing lands without you.",
  },
  health_fault_repeated: {
    decisionClass: "live_infrastructure",
    short: "recommends fixing the repeating fault",
    recommendation:
      "A subsystem keeps failing and the daemon keeps surviving it (see the Health block in `archangel status` for the last error). Fix the cause (GitHub access, permissions, the Scout output); this notice repeats at most once a day per error class.",
  },
  factory_retry_disabled: {
    decisionClass: "owner_signoff",
    short: "recommends editing the repo policy to re-enable",
    recommendation:
      "Factory retries were switched off for this repo because too many ended unmerged, or one was reverted or disputed. It stays off until `.agents/archangel.json` changes in an owner-merged edit (set `escalations.factoryRetry` to `off` to keep it off for good).",
  },
  correction_repeated: {
    decisionClass: "owner_signoff",
    short: "recommends editing the skill or rubric",
    recommendation:
      "You corrected the factory in this category repeatedly this month. Edit a bundled skill, the review rubric (`review.rubric` in .agents/archangel.json) or the implementer prompt for it (an owner-merged change), then watch whether the count drops. Nothing is drafted automatically.",
  },
  pitch_scout_paused: {
    decisionClass: "owner_signoff",
    short: "recommends editing or removing the Scout",
    recommendation:
      "Four pitches in a row were not promoted. Edit the Scout entry or its prompt in .agents/archangel.json (an owner-merged change) to resume it, or remove the Scout.",
  },
  autonomy_cap: {
    decisionClass: "spending",
    short: "recommends replying on any Thread to continue",
    recommendation: "Reply on any Thread or run `archangel retry` to continue.",
  },
  red_main_reverted: {
    decisionClass: "live_infrastructure",
    short: "recommends merging the revert PR",
    recommendation:
      "Review and merge the revert PR to turn main green, then clear the circuit breaker; the original issue can be retried afterwards.",
  },
  scout_auto_promote_revoked: {
    decisionClass: "owner_signoff",
    short: "recommends reviewing the Scout proposals",
    recommendation:
      "This Scout's last 3 auto-promoted Threads ended without a merge, so auto-promotion is off for this version. Review its recent proposals, then edit or remove the Scout entry or prompt (a merged edit lifts the revocation).",
  },
  repo_policy_invalid: {
    decisionClass: "owner_signoff",
    short: "recommends fixing archangel.json via PR",
    recommendation:
      "Fix .agents/archangel.json on the default branch with an owner-merged PR (`archangel doctor` shows the parse error). Archangel takes no new work in this repo until it parses.",
  },
  post_merge_unverified: {
    decisionClass: "live_infrastructure",
    short: "recommends checking main CI by hand",
    recommendation:
      "Archangel could not confirm main's CI result for this merge. Check the default branch's checks by hand; nothing is retried automatically.",
  },
  fix_forward_ready: {
    decisionClass: "live_infrastructure",
    short: "recommends choosing the fix-forward or the revert",
    recommendation:
      "A fix-forward PR for the red main is green and passed the Gate, and the revert PR has not merged. Merge the fix-forward PR, or let the revert land (merge the revert PR); the daemon merges neither and closes the fix-forward if the revert lands first.",
  },
  red_main_manual: {
    decisionClass: "live_infrastructure",
    short: "recommends reverting or fixing forward by hand",
    recommendation:
      "Main moved after the bad merge, so no exact revert exists. Revert or fix-forward by hand, then clear the circuit breaker.",
  },
} as const satisfies Record<string, EscalationPolicy>;


/**
 * Test files named in free text (Gate output, the implementer's own summary): repo-relative paths that look like test files.
 * The text is untrusted; callers must confirm each path mechanically (a test file by the repo's globs, present on base) before
 * acting on it, and only paths of plain characters are ever returned.
 */
export function testFilesMentioned(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/(?<![\w@./+-])((?:[\w@+-]+\/)*[\w@+-]+(?:\.(?:test|spec)\.[a-z]{1,4}|_test\.go|_test\.py|Test\.java))(?![\w])/g)) {
      const p = m[1]!;
      if (!p.startsWith("/") && !p.split("/").includes("..")) found.add(p);
    }
  }
  return [...found].slice(0, 20);
}
