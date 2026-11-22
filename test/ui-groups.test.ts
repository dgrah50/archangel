import { describe, expect, it } from "vitest";
import { NEED_GROUPS, STUCK_MS, buildUiState } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";
import { NEED_GROUPS_UI, isUiState } from "../ui/src/payload.js";

const NOW = 10 * 86_400_000;

describe("groupByNeed", () => {
  const l = new Ledger(":memory:", { repo: "a/b" });
  const mk = (n: number, at: number, phase: Parameters<Ledger["transition"]>[2] | null) => {
    const t = l.upsertThread({ issueNumber: n, title: `t${n}`, bodySha256: `s${n}`, now: at });
    if (phase) l.transition(n, t.version, phase, { now: at });
  };
  mk(1, NOW - 3_600_000, null); // queued, fresh
  mk(2, NOW - 30 * 3_600_000, null); // queued for a long time is still Queued, never Stuck
  mk(3, NOW - 1_000, { kind: "needs_you", code: "review_vetoed", reason: "x", resumeTo: { kind: "queued" } } as never);
  mk(4, NOW - 3_600_000, { kind: "done", outcome: "merged" });
  mk(5, NOW - 20 * 86_400_000, { kind: "done", outcome: "merged" }); // outside 7d
  const g = buildUiState(l, NOW).groups;
  it("queued stays queued however old; needs you and done land in their groups; old done is dropped", () => {
    expect(g["Queued"].map((i) => i.issueNumber).sort()).toEqual([1, 2]);
    expect(g["Needs you"].map((i) => i.issueNumber)).toEqual([3]);
    expect(g["Done in last 7 days"].map((i) => i.issueNumber)).toEqual([4]);
  });
  it("an active Thread with no phase change for over 6h is Stuck, a fresh one is not", () => {
    const m = new Ledger(":memory:", { repo: "a/b" });
    for (const [n, age] of [[1, STUCK_MS + 60_000], [2, 60_000]] as const) {
      const t = m.upsertThread({ issueNumber: n, title: `w${n}`, bodySha256: `s${n}`, now: NOW - age });
      m.transition(n, t.version, { kind: "awaiting_gate", prNumber: n, headSha: "h", baseSha: "b", since: NOW - age, nudgedAt: null } as never, { now: NOW - age });
    }
    const mg = buildUiState(m, NOW).groups;
    expect(mg["Stuck"].map((i) => i.issueNumber)).toEqual([1]);
    expect(mg["Waiting on CI"].map((i) => i.issueNumber)).toEqual([2]);
  });
  it("the browser's group list matches the server's and the guard accepts the payload", () => {
    expect([...NEED_GROUPS_UI]).toEqual([...NEED_GROUPS]);
    expect(isUiState(buildUiState(l, NOW))).toBe(true);
  });
});
