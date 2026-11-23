import { expect, it } from "bun:test";
import { detectAnomalies } from "../src/core/telemetry-scout.js";
import { Ledger } from "../src/ledger/store.js";

const NOW = Date.UTC(2026, 5, 10, 15);
const DAY = 86_400_000;
const add = (l: Ledger, ts: number, outcome: string) => l.insertTelemetry({ ts, repo: "o/r", name: "attempt_ms", value: 1000, tagsJson: JSON.stringify({ outcome }) });
const addGitHubCall = (l: Ledger, ts: number, status: string) => l.insertTelemetry({ ts, repo: "o/r", name: "github_call_ms", value: 1000, tagsJson: JSON.stringify({ status }) });

it("does not flag attempt failures on fewer non-aborted attempts than minWindow", () => {
  const l = new Ledger(":memory:", { repo: "o/r" });
  for (let i = 0; i < 20; i++) add(l, NOW - 2 * DAY - i * 60_000, "succeeded");
  for (let i = 0; i < 4; i++) add(l, NOW - 3_600_000 - i * 60_000, "aborted");
  add(l, NOW - 2 * 3_600_000, "failed");
  expect(detectAnomalies(l, NOW).map((a) => a.metric)).not.toContain("attempt_failures");
});

it("skips a baseline with too few non-aborted attempts", () => {
  const l = new Ledger(":memory:", { repo: "o/r" });
  for (let i = 0; i < 19; i++) add(l, NOW - 2 * DAY - i * 60_000, "aborted");
  add(l, NOW - 2 * DAY - 19 * 60_000, "succeeded");
  for (let i = 0; i < 5; i++) add(l, NOW - 3_600_000 - i * 60_000, "failed");
  expect(detectAnomalies(l, NOW).map((a) => a.metric)).not.toContain("attempt_failures");
});

it("flags GitHub 429s against a clean baseline", () => {
  const l = new Ledger(":memory:", { repo: "o/r" });
  for (let i = 0; i < 10; i++) addGitHubCall(l, NOW - 2 * DAY - i * 60_000, "2xx");
  for (let i = 0; i < 10; i++) addGitHubCall(l, NOW - 3_600_000 - i * 60_000, "429");
  expect(detectAnomalies(l, NOW).map((a) => a.metric)).toContain("github_429s");
});
