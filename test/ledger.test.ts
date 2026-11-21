import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/store.js";

describe("Ledger", () => {
  it("tracks threads, leases, stale-run sweeps, and audit logs", () => {
    const ledger = new Ledger(":memory:", { timeZone: "America/New_York" });
    try {
      const t = ledger.upsertThread({
        issueNumber: 42,
        repo: "dgrah50/gijq",
        title: "Fix parser panic",
        themeLabel: "theme:reliability",
        bodySha256: "abc123",
        now: 1000,
      });
      expect(t.state).toBe("queued");
      expect(t.branchName).toBe("factory/42");

      // Acquire and block second worker
      expect(ledger.acquireLease(42, "w1", 60_000, 2000)).toBe(true);
      expect(ledger.acquireLease(42, "w2", 60_000, 3000)).toBe(false);

      // Simulate crashed implementing attempt -> stale sweep recovers it
      ledger.updateThread(42, { state: "implementing" }, 3000);
      const att = ledger.startAttempt(42, "implement", 3000);
      const swept = ledger.sweepStaleRuns(60_000, 100_000);
      expect(swept).toEqual([42]);
      expect(ledger.getThread(42)?.state).toBe("queued");
      expect(ledger.getThread(42)?.leaseOwner).toBeNull();
      expect(ledger.getAttempt(att.id)?.status).toBe("failed");

      const logs = ledger.listAudit({ issueNumber: 42 });
      expect(logs.some((e) => e.topic === "thread/stale_swept")).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("enforces daily spend, daily merge count, shadow agreement, and circuit breaker", () => {
    const ledger = new Ledger(":memory:", { timeZone: "America/New_York" });
    try {
      const day1 = Date.parse("2026-11-21T15:00:00-05:00");
      const day2 = Date.parse("2026-11-22T15:00:00-05:00");

      ledger.addSpend(12.5, day1);
      ledger.addSpend(8.0, day1);
      expect(ledger.getSpendToday(day1)).toBeCloseTo(20.5);
      expect(ledger.getSpendToday(day2)).toBe(0);

      ledger.upsertThread({ issueNumber: 1, repo: "dgrah50/gijq", title: "a", bodySha256: "h1", now: day1 });
      ledger.upsertThread({ issueNumber: 2, repo: "dgrah50/gijq", title: "b", bodySha256: "h2", now: day1 });
      ledger.upsertThread({ issueNumber: 3, repo: "dgrah50/gijq", title: "c", bodySha256: "h3", now: day1 });

      ledger.recordMerge({ issueNumber: 1, prNumber: 10, headSha: "s1", shadowOnly: true, now: day1 });
      ledger.recordMerge({ issueNumber: 2, prNumber: 11, headSha: "s2", shadowOnly: true, now: day1 });
      ledger.markShadowDisagree(2, true);
      expect(ledger.getAutoMergeCountToday(day1)).toBe(0);
      expect(ledger.getShadowStats()).toEqual({
        total: 2,
        agreed: 1,
        disagreed: 1,
        agreementRate: 0.5,
      });

      ledger.recordMerge({ issueNumber: 3, prNumber: 12, headSha: "s3", squashSha: "sq3", shadowOnly: false, now: day1 });
      expect(ledger.getAutoMergeCountToday(day1)).toBe(1);
      expect(ledger.getAutoMergeCountToday(day2)).toBe(0);

      ledger.setCircuitBreaker(true, "red main on sq3", day1);
      expect(ledger.getCircuitBreaker()).toEqual({ tripped: true, reason: "red main on sq3" });

      // Multi-project isolation: same issue number in a second repo does not collide, while sharing daily_spend
      const repo2 = ledger.forRepo("dgrah50/other");
      repo2.upsertThread({ issueNumber: 1, title: "other repo #1", bodySha256: "otherh1", now: day1 });
      expect(ledger.getThread(1)?.title).toBe("a");
      expect(repo2.getThread(1)?.title).toBe("other repo #1");
      expect(repo2.getSpendToday(day1)).toBeCloseTo(20.5);
      expect(repo2.getCircuitBreaker().tripped).toBe(false);
    } finally {
      ledger.close();
    }
  });
});
