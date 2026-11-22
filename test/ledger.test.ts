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

describe("Ledger outbox ordering", () => {
  it("keeps delivering new effects when 50 older effects keep failing", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    try {
      ledger.upsertThread({ issueNumber: 1, title: "t", bodySha256: "x" });
      const effects = Array.from({ length: 51 }, (_, i) => ({ kind: "add_label" as const, issueNumber: i + 1, label: "needs-you" }));
      const t = ledger.getThread(1)!;
      ledger.transition(1, t.version, { kind: "queued" }, { effects });
      const first = ledger.listDueOutbox();
      expect(first).toHaveLength(50);
      for (const row of first) ledger.failOutbox(row.id, "poison");
      const next = ledger.listDueOutbox().map((r) => r.effect);
      expect(next).toHaveLength(1);
      expect(next[0]).toMatchObject({ issueNumber: 51 });
    } finally {
      ledger.close();
    }
  });
});

describe("daemon lock heartbeat", () => {
  it("returns false once the lock is gone, unreadable or taken by another daemon, and never rewrites it", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    try {
      expect(ledger.heartbeatDaemonLock("a")).toBe(false); // no lock row
      expect(ledger.acquireDaemonLock("a", 1000)).toBe(true);
      expect(ledger.heartbeatDaemonLock("a")).toBe(true);
      ledger.setSystemState("daemon_lock", JSON.stringify({ ownerId: "b", pid: 1, heartbeatAt: 1 }));
      expect(ledger.heartbeatDaemonLock("a")).toBe(false); // stolen
      expect(JSON.parse(ledger.getSystemState("daemon_lock")!).ownerId).toBe("b");
      ledger.setSystemState("daemon_lock", "not json");
      expect(ledger.heartbeatDaemonLock("a")).toBe(false); // unreadable
    } finally {
      ledger.close();
    }
  });
});

describe("Ledger outbox lifecycle", () => {
  const queue = (ledger: Ledger, effect: unknown) => {
    ledger.upsertThread({ issueNumber: 1, title: "t", bodySha256: "x" });
    ledger.transition(1, ledger.getThread(1)!.version, { kind: "queued" }, { effects: [effect as never] });
    return ledger.listDueOutbox()[0]!;
  };

  it("backs off a failed row, then dead-letters it after the attempt cap, auditing once", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    try {
      const row = queue(ledger, { kind: "add_label", issueNumber: 1, label: "x" });
      ledger.failOutbox(row.id, "boom", 1_000);
      expect(ledger.listDueOutbox(1_000)).toHaveLength(0);
      expect(ledger.listDueOutbox(1_000 + 30_000)).toHaveLength(1);
      expect(ledger.hasPendingLabelAdd(1, "x")).toBe(true);
      for (let i = 0; i < 9; i++) ledger.failOutbox(row.id, "boom", 1_000);
      expect(ledger.listDueOutbox(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
      expect(ledger.listDeadOutbox()[0]).toMatchObject({ state: "dead_letter", attempts: 10, lastError: "boom" });
      expect(ledger.hasPendingLabelAdd(1, "x")).toBe(false);
      expect(ledger.listAudit({ topicPrefix: "outbox/dead_letter" })).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });

  it("reads an unknown effect kind as null so it can be dead-lettered rather than delivered or dropped", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    try {
      const row = queue(ledger, { kind: "teleport", issueNumber: 1 });
      expect(row.effect).toBeNull();
      ledger.deadLetterOutbox(row.id, "unknown");
      expect(ledger.listDueOutbox()).toHaveLength(0);
      expect(ledger.listDeadOutbox()).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });

  it("finds a pending label add beyond the first 1000 rows", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    try {
      ledger.upsertThread({ issueNumber: 1, title: "t", bodySha256: "x" });
      const effects = Array.from({ length: 1100 }, (_, i) => ({ kind: "add_label" as const, issueNumber: i + 1, label: "l" }));
      ledger.transition(1, ledger.getThread(1)!.version, { kind: "queued" }, { effects });
      expect(ledger.hasPendingLabelAdd(1100, "l")).toBe(true);
    } finally {
      ledger.close();
    }
  });
});
