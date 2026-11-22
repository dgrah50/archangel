import { describe, expect, it } from "vitest";
import type { DoneOutcome } from "../src/core/thread-machine.js";
import { Ledger } from "../src/ledger/store.js";

const MIN = 60_000;

/** A Thread that ran `attempts` Attempts (each `attemptMin` minutes, `attemptUsd` metered), was approved by `vendors`, and ended `outcome`. */
function seed(
  ledger: Ledger,
  issue: number,
  o: {
    outcome: DoneOutcome | null;
    attempts?: number;
    attemptMin?: number;
    attemptUsd?: number;
    vendors?: Array<"openai" | "anthropic" | "gemini">;
    reviewUsd?: number;
    shadow?: boolean;
    repo?: string;
    now?: number;
  },
) {
  const now = o.now ?? 1000;
  const repo = o.repo ?? ledger.forRepo("a/b").repo;
  const t = ledger.upsertThread({ issueNumber: issue, title: `i${issue}`, bodySha256: `s${issue}`, now, repo });
  for (let i = 0; i < (o.attempts ?? 1); i++) {
    const a = ledger.startAttempt(issue, "implement", now, repo);
    ledger.finishAttempt(a.id, { status: "succeeded", costUsd: o.attemptUsd ?? 0 }, now + (o.attemptMin ?? 1) * MIN);
  }
  for (const vendor of o.vendors ?? []) {
    ledger.recordReview({ issueNumber: issue, headSha: `h${issue}`, vendor, verdict: "approve", findings: [], costUsd: o.reviewUsd ?? 0, now, repo });
  }
  if (o.outcome) {
    ledger.recordMerge({ issueNumber: issue, prNumber: issue, headSha: `h${issue}`, shadowOnly: o.shadow ?? false, mainRequired: ["Test"], now, repo });
    ledger.transition(issue, t.version, { kind: "done", outcome: o.outcome }, { now, repo });
  }
}

describe("Ledger.computeMetrics outcomes", () => {
  it("computes cost, attempts, minutes and rework per merged fix", () => {
    const ledger = new Ledger(":memory:", { repo: "a/b" });
    try {
      seed(ledger, 1, { outcome: "merged", attempts: 1, attemptMin: 2, attemptUsd: 1, vendors: ["openai", "anthropic"], reviewUsd: 0.25 });
      seed(ledger, 2, { outcome: "owner_merged", shadow: true, attempts: 3, attemptMin: 4, attemptUsd: 0 });
      seed(ledger, 3, { outcome: null, attempts: 5, attemptUsd: 9 }); // unmerged spend is excluded
      const o = ledger.computeMetrics({ now: 5000 }).outcomes;
      expect(o.mergedFixes).toBe(2);
      expect(o.meteredUsdTotal).toBe(1.5);
      expect(o.costUsdPerFix).toBe(0.75);
      expect(o.attemptsPerFix).toBe(2);
      expect(o.attemptMinutesPerFix).toBe(7); // (2 + 12) / 2
      expect(o.reworkAttemptsTotal).toBe(2);
      expect(o.reworkAttemptsPerFix).toBe(1);
      expect(o.reverts).toBe(0);
      expect(o.revertsPerFix).toBe(0);
    } finally {
      ledger.close();
    }
  });

  it("counts reverts from main-watch red and from outcome reverted", () => {
    const ledger = new Ledger(":memory:", { repo: "a/b" });
    try {
      seed(ledger, 1, { outcome: "merged" });
      seed(ledger, 2, { outcome: "merged" });
      seed(ledger, 3, { outcome: "reverted" });
      seed(ledger, 4, { outcome: "merged" });
      ledger.updateMergeMainWatch(2, { kind: "red", revertPrNumber: 99, escalated: false });
      const o = ledger.computeMetrics({ now: 5000 }).outcomes;
      expect(o.mergedFixes).toBe(4);
      expect(o.reverts).toBe(2);
      expect(o.revertsPerFix).toBe(0.5);
    } finally {
      ledger.close();
    }
  });

  it("scores each vendor by approved merges not later disagreed or reverted, and disagree works on autonomous merges", () => {
    const ledger = new Ledger(":memory:", { repo: "a/b" });
    try {
      seed(ledger, 1, { outcome: "merged", vendors: ["openai", "anthropic"] });
      seed(ledger, 2, { outcome: "merged", vendors: ["openai", "gemini"] });
      seed(ledger, 3, { outcome: "merged", vendors: ["openai", "anthropic"] });
      seed(ledger, 4, { outcome: "owner_merged", shadow: true, vendors: ["anthropic", "gemini"] });
      expect(ledger.markDisagree(2, true)).toBe(1); // autonomous merge
      expect(ledger.markDisagree(4, true)).toBe(1); // shadow merge
      ledger.updateMergeMainWatch(3, { kind: "red", revertPrNumber: null, escalated: true });
      expect(ledger.markDisagree(999, true)).toBe(0); // no merge: nothing recorded
      const v = ledger.computeMetrics({ now: 5000 }).outcomes.vendorAgreement;
      expect(v.openai).toEqual({ approvedMerges: 3, undisputed: 1, rate: 0.333 });
      expect(v.anthropic).toEqual({ approvedMerges: 3, undisputed: 1, rate: 0.333 });
      expect(v.gemini).toEqual({ approvedMerges: 2, undisputed: 0, rate: 0 });
      // The shadow-only stats are unchanged by autonomous disagreement.
      expect(ledger.computeMetrics({ now: 5000 }).shadow).toMatchObject({ total: 1, disagreed: 1 });
      // Idempotent clear.
      ledger.markDisagree(2, false);
      expect(ledger.computeMetrics({ now: 5000 }).outcomes.vendorAgreement.gemini?.undisputed).toBe(1);
      expect(ledger.computeMetrics({ now: 5000 }).outcomes.vendorAgreement.openai?.undisputed).toBe(2);
    } finally {
      ledger.close();
    }
  });

  it("respects the repo and window filters", () => {
    const ledger = new Ledger(":memory:", { repo: "a/b" });
    try {
      seed(ledger, 1, { outcome: "merged", attempts: 2, now: 100, repo: "a/b" });
      seed(ledger, 2, { outcome: "merged", attempts: 1, now: 200, repo: "a/b" });
      seed(ledger, 3, { outcome: "merged", attempts: 4, now: 200, repo: "c/d" });
      expect(ledger.computeMetrics({ now: 5000 }).outcomes.mergedFixes).toBe(3);
      expect(ledger.computeMetrics({ repo: "a/b", now: 5000 }).outcomes.mergedFixes).toBe(2);
      expect(ledger.computeMetrics({ repo: "a/b", sinceMs: 150, now: 5000 }).outcomes.attemptsPerFix).toBe(1);
      expect(ledger.computeMetrics({ repo: "c/d", sinceMs: 150, now: 5000 }).outcomes.attemptsPerFix).toBe(4);
    } finally {
      ledger.close();
    }
  });

  it("uses nearest-rank p50 and p95 for attempt durations", () => {
    const ledger = new Ledger(":memory:");
    try {
      for (const [index, duration] of [10, 20, 30, 40].entries()) {
        const issueNumber = index + 1;
        ledger.upsertThread({ issueNumber, title: `issue ${issueNumber}`, bodySha256: `sha${issueNumber}`, now: 100 });
        const attempt = ledger.startAttempt(issueNumber, "implement", 100);
        ledger.finishAttempt(attempt.id, { status: "succeeded" }, 100 + duration * 1000);
      }

      const metrics = ledger.computeMetrics({ sinceMs: 1, now: 50000 });
      expect(metrics.attempts.p50DurationSec).toBe(20);
      expect(metrics.attempts.p95DurationSec).toBe(40);
    } finally {
      ledger.close();
    }
  });
});
