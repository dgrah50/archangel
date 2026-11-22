import { afterEach, describe, expect, it } from "bun:test";
import { checkTags } from "../src/core/telemetry-events.js";
import { emit, setTelemetrySink, telemetryDropped, TELEMETRY_RETENTION_MS } from "../src/core/telemetry.js";
import { Ledger } from "../src/ledger/store.js";

const DAY = 86_400_000;
afterEach(() => setTelemetrySink(null));

describe("telemetry", () => {
  it("emit never throws: a failing write is counted and dropped, a good one is stored", () => {
    const ledger = new Ledger(":memory:", { repo: "o/r" });
    setTelemetrySink(ledger);
    emit("tick_ms", 120, {}, "o/r");
    expect(ledger.listTelemetry("tick_ms", 0)).toHaveLength(1);

    const before = telemetryDropped().count;
    setTelemetrySink({ insertTelemetry: () => { throw new Error("database is locked"); } });
    expect(() => emit("tick_ms", 1, {})).not.toThrow();
    expect(telemetryDropped().count).toBe(before + 1);
  });

  it("tags are a closed shape: free text, out-of-enum values and extra keys are rejected", () => {
    expect(checkTags("gate_ms", { outcome: "timeout" })).toEqual({ outcome: "timeout" });
    expect(checkTags("account_cooldown", { account: "work-2" })).toEqual({ account: "work-2" });
    expect(() => checkTags("gate_ms", { outcome: "it took forever, see https://x.test" })).toThrow();
    expect(() => checkTags("account_cooldown", { account: "me@example.com" })).toThrow();
    expect(() => checkTags("gate_ms", { outcome: "passed", note: "x" })).toThrow();
    expect(() => checkTags("not_an_event", {})).toThrow();
  });

  it("retention prunes rows older than the window, in batches", () => {
    const ledger = new Ledger(":memory:", { repo: "o/r" });
    const now = Date.now();
    for (const age of [40, 35, 31, 1]) ledger.insertTelemetry({ ts: now - age * DAY, repo: null, name: "tick_ms", value: 1, tagsJson: "{}" });
    const cutoff = now - TELEMETRY_RETENTION_MS;
    expect(ledger.pruneTelemetry(cutoff, 2)).toBe(2);
    expect(ledger.pruneTelemetry(cutoff, 2)).toBe(1);
    expect(ledger.listTelemetry("tick_ms", 0)).toHaveLength(1);
  });
});
