import type { EscalationCode } from "./thread-machine.js";

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
  recommendation: string;
}

/**
 * Exhaustive by construction: adding an EscalationCode without a class fails typecheck.
 */
export const ESCALATION_POLICY: Record<EscalationCode, EscalationPolicy> = {
  body_changed: {
    decisionClass: "owner_signoff",
    recommendation:
      "Review the edited issue body. If it is what you want built, remove `needs-you` (or `archangel retry`); otherwise revert the edit.",
  },
  already_fixed: {
    decisionClass: "product_decision",
    recommendation:
      "Confirm the bug no longer reproduces on main and close the issue; if it still does, comment with a reproduction and retry.",
  },
  broker_policy_failed: {
    decisionClass: "owner_signoff",
    recommendation:
      "The fix needs protected paths or exceeds diff bounds. Narrow the issue, or take it over with `archangel handoff`.",
  },
  gate_failed: {
    decisionClass: "live_infrastructure",
    recommendation:
      "Read the Gate output on the PR. Comment guidance and retry, or close the PR; do not merge without a passing Gate.",
  },
  gate_timeout: {
    decisionClass: "live_infrastructure",
    recommendation:
      "Required checks never finished. Check the workflow run on the PR, fix or re-run CI, then retry.",
  },
  gate_untrusted: {
    decisionClass: "credentials",
    recommendation:
      "A required check came from an unexpected app. Verify the repo's Gate workflow and app installation before retrying.",
  },
  review_vetoed: {
    decisionClass: "live_infrastructure",
    recommendation:
      "Read the reviewer findings in the Recap. Comment guidance and retry, merge yourself if the veto is wrong, or close the PR.",
  },
  review_outage: {
    decisionClass: "credentials",
    recommendation: "Reviewer CLIs are unavailable. Run `archangel doctor --smoke`, re-login where needed, then retry.",
  },
  merge_conflict: {
    decisionClass: "live_infrastructure",
    recommendation:
      "The branch conflicts with main and the automatic rebase failed. Retry for a fresh Attempt, or resolve it with `archangel handoff`.",
  },
  attempt_timeout: {
    decisionClass: "spending",
    recommendation: "The Attempt used its whole time budget. Narrow the issue or comment a hint, then retry.",
  },
  attempt_failed: {
    decisionClass: "product_decision",
    recommendation:
      "The implementer could not produce a valid fix. Read its summary, comment what it missed (your comment reaches the next Attempt), then retry.",
  },
  max_attempts: {
    decisionClass: "spending",
    recommendation: "The Attempt cap is used up. Retry to grant a fresh budget, or close the issue if it is not worth more runs.",
  },
};

/** One-tap answers the owner can post as a comment on the Thread's issue or PR. */
export const OWNER_COMMANDS_LINE =
  "Reply `/archangel retry` with a hint, `/archangel close`, or `/archangel handoff`.";

export function describeEscalation(code: EscalationCode, workClass: "bugfix" | "feature" = "bugfix"): EscalationPolicy {
  const policy = ESCALATION_POLICY[code];
  const feature = workClass === "feature" ? " This is a feature Thread: the owner merges it." : "";
  return { ...policy, recommendation: `${policy.recommendation}${feature} ${OWNER_COMMANDS_LINE}` };
}

export function formatDecisionClass(c: DecisionClass): string {
  return c.replace(/_/g, " ");
}

/** Escalations raised by project-level monitors (autonomy cap, post-merge main) rather than by a Thread. */
export const MAIN_ESCALATION_POLICY = {
  correction_repeated: {
    decisionClass: "owner_signoff",
    recommendation:
      "You corrected the factory in this category repeatedly this month. Edit a bundled skill, the review rubric (`review.rubric` in .agents/archangel.json) or the implementer prompt for it (an owner-merged change), then watch whether the count drops. Nothing is drafted automatically.",
  },
  pitch_scout_paused: {
    decisionClass: "owner_signoff",
    recommendation:
      "Four pitches in a row were not promoted. Edit the Scout entry or its prompt in .agents/archangel.json (an owner-merged change) to resume it, or remove the Scout.",
  },
  autonomy_cap: {
    decisionClass: "spending",
    recommendation: "Reply on any Thread or run `archangel retry` to continue.",
  },
  red_main_reverted: {
    decisionClass: "live_infrastructure",
    recommendation:
      "Review and merge the revert PR to turn main green, then clear the circuit breaker; the original issue can be retried afterwards.",
  },
  scout_auto_promote_revoked: {
    decisionClass: "owner_signoff",
    recommendation:
      "This Scout's last 3 auto-promoted Threads ended without a merge, so auto-promotion is off for this version. Review its recent proposals, then edit or remove the Scout entry or prompt (a merged edit lifts the revocation).",
  },
  repo_policy_invalid: {
    decisionClass: "owner_signoff",
    recommendation:
      "Fix .agents/archangel.json on the default branch with an owner-merged PR (`archangel doctor` shows the parse error). Archangel takes no new work in this repo until it parses.",
  },
  red_main_manual: {
    decisionClass: "live_infrastructure",
    recommendation:
      "Main moved after the bad merge, so no exact revert exists. Revert or fix-forward by hand, then clear the circuit breaker.",
  },
} as const satisfies Record<string, EscalationPolicy>;
