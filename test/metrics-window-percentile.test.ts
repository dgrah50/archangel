import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/store.js";

describe("Ledger.computeMetrics windows and percentiles", () => {
  it("filters shadow stats by sinceMs", () => {
    const ledger = new Ledger(":memory:");
    try {
      ledger.upsertThread({ issueNumber: 1, title: "old", bodySha256: "old", now: 100 });
      ledger.upsertThread({ issueNumber: 2, title: "new", bodySha256: "new", now: 200 });
      ledger.recordMerge({ issueNumber: 1, prNumber: 1, headSha: "old", shadowOnly: true, now: 100 });
      ledger.recordMerge({ issueNumber: 2, prNumber: 2, headSha: "new", shadowOnly: true, now: 200 });
      ledger.markShadowDisagree(2, true);

      expect(ledger.computeMetrics({ sinceMs: 150, now: 300 }).shadow).toEqual({
        total: 1,
        agreed: 0,
        disagreed: 1,
        agreementRate: 0,
      });
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
