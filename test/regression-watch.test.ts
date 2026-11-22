import { describe, expect, it } from "bun:test";
import { buildDigest } from "../src/core/digest.js";
import { ingestSignals } from "../src/core/signals.js";
import { Ledger } from "../src/ledger/store.js";

const NOW = Date.UTC(2026, 5, 15, 12);
const DAY = 86_400_000;
const sha = (c: string) => c.repeat(64);

describe("regression watch", () => {
  it("flags a policy version whose rework rose, with a revert hint, and not a stable one", async () => {
    const ledger = new Ledger(":memory:", { repo: "o/r" });
    let issue = 0;
    // Three Threads per policy version, started on day `day`; `rework` of them needed a revision.
    const version = (wf: string, day: number, rework: number) => {
      for (let i = 0; i < 3; i++) {
        const n = ++issue;
        ledger.upsertThread({ issueNumber: n, title: "t", bodySha256: "x", now: NOW - day * DAY });
        const a = ledger.startAttempt(n, "implement", NOW - day * DAY);
        ledger.recordAttemptProvenance(a.id, { promptSha256: sha("1"), workflowSha256: sha(wf) });
        if (i < rework) (ledger as unknown as { db: { run(sql: string, ...p: unknown[]): void } }).db.run("UPDATE threads SET revision_count = 1 WHERE issue_number = ?", n);
      }
    };
    version("a", 9, 0);
    version("b", 6, 2); // rework 0% -> 67%
    version("c", 3, 2); // 67% -> 67%: stable against its predecessor

    await ingestSignals({ ledger, github: {} as never, defaultBranch: "main", wanted: new Set(), schedules: [], now: NOW, onError: (_, e) => { throw e; }, introducedBy: async (kind) => (kind === "workflow" ? "abc1234" : null) });

    const flagged = ledger.listSignals(0).filter((s) => s.kind === "policy_regression");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ taint: "mechanical", payload: { workflowSha: sha("b"), workflowCommit: "abc1234" } });
    const digest = buildDigest(ledger.collectDigestInput(NOW))!;
    expect(digest).toContain("rework 0% -> 67%");
    expect(digest).toContain("git revert workflow change abc1234");
  });
});
