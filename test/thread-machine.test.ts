import { describe, expect, it } from "vitest";
import { classifyGate, stepPhase, type Phase } from "../src/core/thread-machine.js";

const META = { issueNumber: 1, title: "Bug", needsYouLabel: "needs-you" };

const ALL_NON_DONE_PHASES: Phase[] = [
  { kind: "queued" },
  {
    kind: "working",
    attemptId: 1,
    attempt: "implement",
    fromSha: "base1",
    resumeTo: { kind: "queued" },
  },
  {
    kind: "awaiting_gate",
    prNumber: 10,
    headSha: "h1",
    baseSha: "b1",
    since: 1000,
    nudgedAt: null,
  },
  {
    kind: "reviewing",
    prNumber: 10,
    headSha: "h1",
    baseSha: "b1",
    outageSince: null,
  },
  { kind: "landing", prNumber: 10, headSha: "h1", baseSha: "b1" },
  { kind: "shadow_ready", prNumber: 10, headSha: "h1", baseSha: "b1", verdictId: 1 },
  {
    kind: "needs_you",
    code: "gate_failed",
    reason: "failed",
    resumeTo: { kind: "queued" },
  },
  {
    kind: "owner_driving",
    paseoAgentId: "ag_1",
    paseoWorkspaceId: "ws_1",
    since: 1000,
    prNumber: 10,
    headSha: "h1",
    baseSha: "b1",
  },
];

describe("thread-machine global invariants", () => {
  it("every non-done phase exits cleanly on owner_abandon and pr_observed(merged)", () => {
    for (const p of ALL_NON_DONE_PHASES) {
      const abandoned = stepPhase(p, "autonomous", { t: "owner_abandon" }, META);
      expect(abandoned.ok && abandoned.next.kind).toBe("done");

      const merged = stepPhase(p, "autonomous", { t: "pr_observed", status: "merged" }, META);
      expect(merged.ok && merged.next).toMatchObject({ kind: "done", outcome: "owner_merged" });
    }
  });

  it("advisory mode structurally forbids start_working from EVERY phase", () => {
    for (const p of ALL_NON_DONE_PHASES) {
      const res = stepPhase(
        p,
        "advisory",
        { t: "start_working", attemptId: 9, attempt: "revise", fromSha: "h1" },
        META,
      );
      expect(res.ok).toBe(false);
    }
  });

  it("restart_recovered ONLY applies to working phases (never touches needs_you/shadow_ready/owner_driving)", () => {
    for (const p of ALL_NON_DONE_PHASES) {
      const res = stepPhase(p, "autonomous", { t: "restart_recovered" }, META);
      if (p.kind === "working") {
        expect(res.ok && res.next.kind).toBe("queued");
      } else {
        expect(res.ok).toBe(false);
      }
    }
  });

  it("classifyGate fails closed when appSlug is null or non-github-actions", () => {
    const res = classifyGate({
      requiredChecks: ["Gate"],
      checks: [{ id: 1, name: "Gate", status: "completed", conclusion: "success", appSlug: null }],
      since: 0,
      now: 1000,
      graceMs: 5000,
      timeoutMs: 60_000,
    });
    expect(res.status).toBe("untrusted");
  });
});
