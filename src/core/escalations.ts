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
  revision_no_change: {
    decisionClass: "live_infrastructure",
    recommendation:
      "The revision came back byte-identical to the previous head: the implementer could not meet the feedback within the rules. Read its summary and the findings, then comment what it should do differently and retry, or close the PR.",
  },
  existing_test_conflict: {
    decisionClass: "product_decision",
    recommendation:
      "The issue contradicts an existing test (named in the reason), and existing tests are immutable for the factory. Decide which behaviour is right: edit the issue to match the test, or change the test yourself; then retry or close.",
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
  dependency_unmet: {
    decisionClass: "owner_signoff",
    recommendation:
      "The slice this one was chained after ended without merging (closed or abandoned). Retry to run this slice on its own, or close it if it only made sense after that one.",
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
  health_fault_repeated: {
    decisionClass: "live_infrastructure",
    recommendation:
      "A subsystem keeps failing and the daemon keeps surviving it (see the Health block in `archangel status` for the last error). Fix the cause (GitHub access, permissions, the Scout output); this notice repeats at most once a day per error class.",
  },
  factory_retry_disabled: {
    decisionClass: "owner_signoff",
    recommendation:
      "Factory retries were switched off for this repo because too many ended unmerged, or one was reverted or disputed. It stays off until `.agents/archangel.json` changes in an owner-merged edit (set `escalations.factoryRetry` to `off` to keep it off for good).",
  },
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
  post_merge_unverified: {
    decisionClass: "live_infrastructure",
    recommendation:
      "Archangel could not confirm main's CI result for this merge. Check the default branch's checks by hand; nothing is retried automatically.",
  },
  red_main_manual: {
    decisionClass: "live_infrastructure",
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
