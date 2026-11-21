import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/store.js";

describe("Ledger (CAS transitions, daemon lock, budget reservations, multi-project)", () => {
  it("enforces compare-and-set version checks and sweeps ONLY working phases on startup", () => {
    const ledger = new Ledger(":memory:", { timeZone: "America/New_York" });
    try {
      const t1 = ledger.upsertThread({
        issueNumber: 42,
        title: "Fix parser panic",
        themeLabel: "theme:reliability",
        bodySha256: "abc123",
        now: 1000,
      });
      expect(t1.phase.kind).toBe("queued");
      expect(t1.version).toBe(0);

      // CAS transition succeeds on matching version, rejects stale version
      const att = ledger.startAttempt(42, "implement", 2000);
      const tWorking = ledger.transition(
        42,
        0,
        {
          kind: "working",
          attemptId: att.id,
          attempt: "implement",
          fromSha: "base1",
          resumeTo: { kind: "queued" },
        },
        { now: 2000 },
      );
      expect(tWorking?.version).toBe(1);
      expect(ledger.transition(42, 0, { kind: "done", outcome: "abandoned" })).toBeNull();

      // Create a second thread already in needs_you — startup sweep MUST NOT touch it (Opus L1)!
      ledger.upsertThread({
        issueNumber: 43,
        title: "Escalated bug",
        bodySha256: "def456",
        phase: {
          kind: "needs_you",
          code: "gate_failed",
          reason: "needs owner",
          resumeTo: { kind: "queued" },
        },
        now: 1000,
      });

      const swept = ledger.sweepStaleWorkingRuns(5000);
      expect(swept).toEqual([42]);
      expect(ledger.getThread(42)?.phase.kind).toBe("queued");
      expect(ledger.getThread(43)?.phase.kind).toBe("needs_you");
      expect(ledger.getAttempt(att.id)?.status).toBe("failed");

      // Single daemon lock prevents concurrent daemon start
      expect(ledger.acquireDaemonLock("d1", 60_000, 10_000)).toBe(true);
      expect(ledger.acquireDaemonLock("d2", 60_000, 20_000)).toBe(false);
      ledger.releaseDaemonLock("d1");
      expect(ledger.acquireDaemonLock("d2", 60_000, 25_000)).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("enforces atomic budget reservations, INSERT OR IGNORE SHA provenance, shadow dedupe, and multi-project isolation", () => {
    const ledger = new Ledger(":memory:", { timeZone: "America/New_York" });
    try {
      const day1 = Date.parse("2026-11-21T15:00:00-05:00");
      const day2 = Date.parse("2026-11-22T15:00:00-05:00");

      // Atomic reservations prevent overspending $20/day across concurrent attempts
      const r1 = ledger.reserveBudget(20, 12, 0.05, day1);
      const r2 = ledger.reserveBudget(20, 12, 0.05, day1);
      const r3 = ledger.reserveBudget(20, 12, 0.05, day1);
      expect(r1).toBe(12);
      expect(r2).toBe(8);
      expect(r3).toBeNull();

      ledger.settleBudget(12, 10.5, day1);
      ledger.settleBudget(8, 9.5, day1);
      expect(ledger.getSpendToday(day1)).toBeCloseTo(20.0);
      expect(ledger.getSpendToday(day2)).toBe(0);

      ledger.upsertThread({ issueNumber: 1, title: "a", bodySha256: "h1", now: day1 });
      // INSERT OR IGNORE keeps broker provenance even if owner_resume touches same SHA (Opus R14)
      ledger.recordPushedSha("sha1", 1, "broker", day1);
      ledger.recordPushedSha("sha1", 1, "owner_resume", day1);
      expect(ledger.isKnownSha(1, "sha1")).toEqual({ known: true, origin: "broker" });

      // Shadow Mode deduplicates by (repo, issue, headSha)
      const m1 = ledger.recordMerge({ issueNumber: 1, prNumber: 10, headSha: "sha1", shadowOnly: true, now: day1 });
      const m2 = ledger.recordMerge({ issueNumber: 1, prNumber: 10, headSha: "sha1", shadowOnly: true, now: day1 });
      expect(m2.id).toBe(m1.id);
      expect(ledger.getShadowStats().total).toBe(1);

      // Multi-project isolation shares daily_spend but isolates threads and circuit breakers
      const repo2 = ledger.forRepo("dgrah50/other");
      repo2.upsertThread({ issueNumber: 1, title: "other #1", bodySha256: "oh1", now: day1 });
      ledger.setCircuitBreaker(true, "red main", day1);
      expect(ledger.getThread(1)?.title).toBe("a");
      expect(repo2.getThread(1)?.title).toBe("other #1");
      expect(repo2.getSpendToday(day1)).toBeCloseTo(20.0);
      expect(repo2.getCircuitBreaker().tripped).toBe(false);
    } finally {
      ledger.close();
    }
  });
});
