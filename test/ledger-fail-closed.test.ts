import { describe, expect, it } from "bun:test";
import { Ledger } from "../src/ledger/store.js";

describe("ledger reads fail closed on unreadable state", () => {
  it("a corrupt daemon lock reads as an active daemon and blocks acquireDaemonLock", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    ledger.setSystemState("daemon_lock", "{not json", Date.now());
    expect(ledger.isDaemonActive(60_000)).toBe(true);
    expect(ledger.acquireDaemonLock("d2", 60_000)).toBe(false);
    ledger.setSystemState("daemon_lock", JSON.stringify({ ownerId: "x" }), Date.now());
    expect(ledger.isDaemonActive(60_000)).toBe(true);
    expect(ledger.acquireDaemonLock("d2", 60_000)).toBe(false);
    ledger.close();
  });

  it("a malformed scout/run row counts against the daily cap", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const now = Date.now();
    (ledger as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare(`INSERT INTO audit_log (ts, repo, topic, issue_number, actor, payload_json) VALUES (?, ?, 'scout/run', NULL, 's', ?)`)
      .run(now, "acme/app", "garbage");
    expect(ledger.tryReserveScoutRun("s", 1, false, now)).toBe(false);
  });

  it("a cooldown read error propagates instead of showing none", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    (ledger as unknown as { db: { exec: (q: string) => void } }).db.exec("DROP TABLE account_cooldowns");
    expect(() => ledger.listActiveCooldowns()).toThrow();
  });
});
