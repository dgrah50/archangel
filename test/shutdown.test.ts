import { describe, expect, test } from "bun:test";
import { Ledger } from "../src/ledger/store.js";
import { settleWithin } from "../src/core/shutdown.js";

describe("shutdown deadline", () => {
  test("in-flight work that never settles cannot keep the Ledger lock past the deadline", async () => {
    const ledger = new Ledger(":memory:", { repo: "o/r" });
    expect(ledger.acquireDaemonLock("a", 60_000)).toBe(true);
    const settled = await settleWithin(new Promise(() => {}), 50);
    expect(settled).toBe(false);
    ledger.releaseDaemonLock("a");
    expect(ledger.acquireDaemonLock("b", 60_000)).toBe(true);
  });
});
