import { describe, expect, it } from "vitest";
import { renderStages } from "../src/core/status-text.js";
import { groupThreads } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";

const NOW = 10 * 86_400_000;
const HOUR = 3_600_000;

describe("archangel status stage rendering", () => {
  it("groups by stage in dashboard order with outcome labels, skipping empty groups and the Needs You stage", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const mk = (issue: number, title: string, phase: Parameters<Ledger["transition"]>[2] | null, now = NOW - 2 * HOUR) => {
      const t = l.upsertThread({ issueNumber: issue, title, bodySha256: `s${issue}`, now });
      if (phase) l.transition(issue, t.version, phase, { now });
    };
    mk(1, "stuck", { kind: "needs_you", code: "review_vetoed", reason: "x", resumeTo: { kind: "queued" } } as never);
    mk(2, "waiting", null);
    mk(3, "shipped", { kind: "done", outcome: "merged" });
    mk(4, "closed", { kind: "done", outcome: "pr_closed" });
    mk(5, "ancient", { kind: "done", outcome: "merged" }, NOW - 8 * 24 * HOUR);

    const { stages, needsYou } = groupThreads(l.listAllThreads(), NOW);
    expect(needsYou).toHaveLength(1);
    const text = renderStages(stages, NOW).join("\n");

    expect(text).toContain("Queued (1):\n  a/b#2  [queued, 2h]  no PR  waiting");
    expect(text).toContain("Done in last 7 days (2):");
    expect(text).toContain("[merged, 2h]  no PR  shipped");
    expect(text).toContain("[PR closed, 2h]  no PR  closed");
    expect(text.indexOf("Queued")).toBeLessThan(text.indexOf("Done in last 7 days"));
    expect(text).not.toContain("ancient");
    expect(text).not.toContain("stuck"); // Needs You is printed separately, first
    expect(text).not.toContain("Working");
    expect(text).not.toContain("Needs you");
  });

  it("renders nothing for an empty ledger", () => {
    expect(renderStages(groupThreads([], NOW).stages, NOW)).toEqual([]);
  });
});
