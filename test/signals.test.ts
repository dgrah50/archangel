import { describe, expect, it } from "bun:test";
import { recordSignal } from "../src/core/signals.js";
import { Ledger } from "../src/ledger/store.js";

describe("signal ingestion", () => {
  it("ingesting the same event twice stores one signal", () => {
    const ledger = new Ledger(":memory:", { repo: "o/r" });
    const at = Date.UTC(2026, 5, 10);
    expect(recordSignal(ledger, "pr_merged", "7", { number: 7 }, at)).toBe(true);
    expect(recordSignal(ledger, "pr_merged", "7", { number: 7 }, at)).toBe(false);
    expect(ledger.listSignals(0)).toHaveLength(1);
  });
});
