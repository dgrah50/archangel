import { describe, expect, it } from "vitest";
import { buildDigest, sendDigestIfDue } from "../src/core/digest.js";
import { UNAVAILABLE, buildMetricsBlock, buildMetricsBlockFrom } from "../src/core/metrics-block.js";
import { Ledger } from "../src/ledger/store.js";

describe("unavailable is not empty: metrics block", () => {
  it("renders every figure as unavailable when the source fails, distinct from a real zero", () => {
    const failed = buildMetricsBlockFrom(() => {
      throw new Error("db locked");
    });
    expect(failed).toContain(`threads_total: ${UNAVAILABLE}`);
    expect(failed).toContain(`outcomes: ${UNAVAILABLE}`);
    expect(failed).toContain(`  - ${UNAVAILABLE}`);
    expect(failed).not.toContain("none");
    expect(buildMetricsBlock(null)).toBe(failed);

    const l = new Ledger(":memory:", { repo: "a/b" });
    const real = buildMetricsBlock(l.computeMetrics({ repo: "a/b", now: 1 }));
    expect(real).toContain("threads_total: 0");
    expect(real).toContain("escalations_by_code: none");
    expect(real).not.toContain(UNAVAILABLE);
    l.close();
  });
});

describe("unavailable is not empty: digest", () => {
  const known = { needsYou: [], proposals: [], pitches: [], faults: [], draftReverts: [], now: 0 };
  it("a known zero stays quiet, an unavailable figure is shown and keeps the digest alive", () => {
    expect(buildDigest({ ...known, yesterday: { autonomousMerges: 0, ownerMerges: 0, reverts: 0, spendUsd: 0 } })).toBeNull();
    const text = buildDigest({ ...known, yesterday: { autonomousMerges: 0, ownerMerges: null, reverts: 0, spendUsd: null } })!;
    expect(text).toContain("Merges: 0 autonomous, unavailable owner");
    expect(text).toContain("Reverts (red main): 0");
    expect(text).toContain("Metered spend: unavailable");
  });
  it("a failed ledger query makes that figure null; a failed GitHub read makes proposals unavailable", async () => {
    const l = new Ledger(":memory:", { repo: "a/b", timeZone: "UTC" });
    (l as unknown as { db: { exec(s: string): void } }).db.exec("DROP TABLE daily_spend");
    const input = l.collectDigestInput(Date.UTC(2026, 2, 10, 14));
    expect(input.yesterday.spendUsd).toBeNull();
    expect(input.yesterday.autonomousMerges).toBe(0);

    const sent: string[] = [];
    await sendDigestIfDue(
      l,
      { sendDigest: async (t) => void sent.push(t) },
      {
        now: Date.UTC(2026, 2, 10, 14),
        timeZone: "UTC",
        digestHour: 9,
        openProposals: async () => {
          throw new Error("github down");
        },
      },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Metered spend: unavailable");
    expect(sent[0]).toContain("Scout proposals awaiting you: unavailable");
    l.close();
  });
});
