import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { stepPhase, type MachineEvent, type Mode, type Phase } from "../src/core/thread-machine.js";
import { buildThreadDetail } from "../src/core/ui-thread.js";
import { Ledger } from "../src/ledger/store.js";

function mustStep(phase: Phase, mode: Mode, ev: MachineEvent, issueNumber = 1) {
  const res = stepPhase(phase, mode, ev, { issueNumber, title: "t", needsYouLabel: "needs-you" });
  if (!res.ok) throw new Error(res.reject);
  return res.next;
}

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
        mustStep(t1.phase, t1.mode, { t: "start_working", attemptId: att.id, attempt: "implement", fromSha: "base1" }, 42),
        { now: 2000 },
      );
      expect(tWorking?.version).toBe(1);
      expect(ledger.transition(42, 0, mustStep(t1.phase, t1.mode, { t: "owner_abandon" }, 42))).toBeNull();

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
      ledger.transition(1, t.version, mustStep(t.phase, t.mode, { t: "escalate", code: "gate_failed", reason: "x" }), { effects });
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

  it("refuses to release another daemon's lock and rolls back retry grants when CAS loses a race", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    try {
      expect(ledger.acquireDaemonLock("d1", 1000, 10_000)).toBe(true);
      expect(ledger.acquireDaemonLock("d2", 1000, 12_000)).toBe(true);
      ledger.releaseDaemonLock("d1");
      expect(ledger.heartbeatDaemonLock("d2", 12_500)).toBe(true);

      const t = ledger.upsertThread({
        issueNumber: 7,
        title: "Race",
        bodySha256: "h1",
        phase: { kind: "needs_you", code: "gate_failed", reason: "failed", resumeTo: { kind: "queued" } },
        now: 1000,
      });
      const retryNext = mustStep(t.phase, t.mode, { t: "owner_retry", now: 2000 }, 7);
      // Simulate another transition winning first.
      expect(ledger.transition(7, t.version, mustStep(t.phase, t.mode, { t: "owner_abandon" }, 7), { now: 1500 })).not.toBeNull();
      // Stale retry CAS fails: no retry budget, no owner reply, no thread/owner_retry audit row.
      expect(
        ledger.transition(7, t.version, retryNext, {
          ownerReply: "try again",
          grantRetryBudget: true,
          extraAudits: [{ topic: "thread/owner_retry", actor: "owner", payload: { via: "comment", code: "gate_failed" } }],
          now: 2000,
        }),
      ).toBeNull();
      const after = ledger.getThread(7)!;
      expect(after.phase).toMatchObject({ kind: "done", outcome: "abandoned" });
      expect(after.retryGrants).toBe(0);
      expect(after.ownerReply).toBeNull();
      expect(ledger.listAudit({ topicPrefix: "thread/owner_retry" })).toHaveLength(0);
    } finally {
      ledger.close();
    }
  });

  it("enforces daemon lock, handoff command mutual exclusion, and CAS retry atomicity across two real WAL SQLite connections", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-wal-"));
    const dbPath = path.join(dir, "ledger.db");
    const daemonA = new Ledger(dbPath, { repo: "acme/app" });
    const daemonB = new Ledger(dbPath, { repo: "acme/app" });
    try {
      expect(daemonA.acquireDaemonLock("d1", 1000, 10_000)).toBe(true);
      expect(daemonB.acquireDaemonLock("d2", 1000, 10_500)).toBe(false);
      // Stale takeover by d2, followed by delayed release by d1, must leave d2's lock intact.
      expect(daemonB.acquireDaemonLock("d2", 1000, 11_500)).toBe(true);
      daemonA.releaseDaemonLock("d1");
      expect(daemonB.heartbeatDaemonLock("d2", 11_600)).toBe(true);

      // Handoff command mutual exclusion across two connections.
      const cmdId = daemonA.enqueueCommand(9, "handoff", 12_000);
      expect(daemonB.claimCommand(cmdId, 12_010)).toBe(true);
      expect(daemonA.cancelCommand(cmdId, "timeout", 12_020)).toBe(false);
      expect(daemonB.completeCommand(cmdId, { ok: true }, 12_030)).toBe(true);

      // CAS race on owner_retry across two connections leaks no retry budget or audit row.
      const t = daemonA.upsertThread({
        issueNumber: 9,
        title: "WAL CAS",
        bodySha256: "h1",
        phase: { kind: "needs_you", code: "gate_failed", reason: "red", resumeTo: { kind: "queued" } },
        now: 12_000,
      });
      const retryNext = mustStep(t.phase, t.mode, { t: "owner_retry", now: 12_100 }, 9);
      const abandonNext = mustStep(t.phase, t.mode, { t: "owner_abandon" }, 9);
      expect(daemonB.transition(9, t.version, abandonNext, { now: 12_050 })).not.toBeNull();
      expect(
        daemonA.transition(9, t.version, retryNext, {
          ownerReply: "hint",
          grantRetryBudget: true,
          extraAudits: [{ topic: "thread/owner_retry", actor: "owner", payload: { via: "cli", code: "gate_failed" } }],
          now: 12_100,
        }),
      ).toBeNull();
      const finalThread = daemonB.getThread(9)!;
      expect(finalThread.phase).toMatchObject({ kind: "done", outcome: "abandoned" });
      expect(finalThread.retryGrants).toBe(0);
      expect(finalThread.ownerReply).toBeNull();
      expect(daemonB.listAudit({ topicPrefix: "thread/owner_retry" })).toHaveLength(0);
    } finally {
      daemonA.close();
      daemonB.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Ledger outbox lifecycle", () => {
  const queue = (ledger: Ledger, effect: unknown) => {
    const t = ledger.upsertThread({ issueNumber: 1, title: "t", bodySha256: "x" });
    ledger.transition(1, t.version, mustStep(t.phase, t.mode, { t: "escalate", code: "gate_failed", reason: "x" }), { effects: [effect as never] });
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

});

describe("Ledger phase entry history", () => {
  it("records the entered phase kind on every transition audit row, with or without an audit topic", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    try {
      const t = ledger.upsertThread({ issueNumber: 5, title: "t", bodySha256: "x", now: 1000 });
      const att = ledger.startAttempt(5, "implement", 2000);
      const w = ledger.transition(5, t.version, mustStep(t.phase, t.mode, { t: "start_working", attemptId: att.id, attempt: "implement", fromSha: "b" }, 5), { now: 2000, auditTopic: "x/y", auditPayload: { a: 1 } })!;
      ledger.transition(5, w.version, mustStep(w.phase, w.mode, { t: "escalate", code: "gate_failed", reason: "r" }, 5), { now: 62_000 });
      const rows = ledger.listAudit({ repo: "acme/app", issueNumber: 5, limit: 10 });
      expect(rows.find((r) => r.topic === "x/y")?.payloadJson).toBe(JSON.stringify({ a: 1, phase: "working" }));
      expect(rows.find((r) => r.topic === "thread/phase_entered")?.payloadJson).toBe(JSON.stringify({ phase: "needs_you" }));
      expect(buildThreadDetail(ledger, "acme/app", 5, 100_000)!.phaseDurations).toEqual([
        { kind: "working", ms: 60_000, running: false, limitMs: null },
        { kind: "needs_you", ms: 38_000, running: true, limitMs: null },
      ]);
    } finally {
      ledger.close();
    }
  });
});
