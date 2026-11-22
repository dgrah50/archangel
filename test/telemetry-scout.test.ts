import { describe, expect, it } from "bun:test";
import { ingestSignals } from "../src/core/signals.js";
import { Ledger } from "../src/ledger/store.js";

const NOW = Date.UTC(2026, 5, 10, 15);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 60 GitHub calls a day for the last 8 days (day 0 is the last 24h), each with latency `ms(day, i)`. */
function seed(ledger: Ledger, ms: (day: number, i: number) => number) {
  for (let d = 0; d < 8; d++) {
    for (let i = 0; i < 60; i++) {
      ledger.insertTelemetry({ ts: NOW - d * DAY - (i + 1) * 10 * 60_000, repo: "o/r", name: "github_call_ms", value: ms(d, i), tagsJson: JSON.stringify({ endpoint: "pulls", status: "2xx" }) });
    }
  }
}

const hourly = async (ledger: Ledger) => {
  const errors: unknown[] = [];
  for (let h = 0; h < 6; h++) {
    await ingestSignals({ ledger, github: {} as never, defaultBranch: "main", wanted: new Set(), schedules: [], now: NOW + h * HOUR, onError: (_, e) => errors.push(e) });
  }
  expect(errors).toEqual([]);
  return ledger.listSignals(0).filter((s) => s.kind === "telemetry_anomaly");
};

describe("telemetry Scout", () => {
  it("records one mechanical signal for a sustained regression and none for normal variance", async () => {
    const regressed = new Ledger(":memory:", { repo: "o/r" });
    seed(regressed, (day, i) => (day === 0 ? 1600 + (i % 5) * 20 : 400 + (i % 5) * 20));
    const found = await hourly(regressed);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ taint: "mechanical", payload: { metric: "github_latency", window: "24h", repo: "o/r" } });

    const normal = new Ledger(":memory:", { repo: "o/r" });
    seed(normal, (day, i) => 400 + ((i * 7 + day) % 9) * 15);
    expect(await hourly(normal)).toHaveLength(0);
  });
});
