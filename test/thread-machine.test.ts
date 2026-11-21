import { describe, expect, it } from "vitest";
import {
  classifyGate,
  deriveControl,
  stepPhase,
  type Phase,
} from "../src/core/thread-machine.js";

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

describe("thread-machine invariants (Opus audit proofs)", () => {
  it("every non-done phase has an owner exit (owner_abandon) and transitions cleanly on pr_observed", () => {
    for (const p of ALL_NON_DONE_PHASES) {
      const abandoned = stepPhase(p, "autonomous", { t: "owner_abandon" }, META);
      expect(abandoned.ok).toBe(true);
      if (abandoned.ok) {
        expect(abandoned.next.kind).toBe("done");
      }

      const merged = stepPhase(p, "autonomous", { t: "pr_observed", status: "merged" }, META);
      expect(merged.ok).toBe(true);
      if (merged.ok) {
        expect(merged.next).toMatchObject({ kind: "done", outcome: "owner_merged" });
      }
    }
  });

  it("advisory mode structurally forbids start_working from EVERY phase (prevents Opus R4)", () => {
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

  it("restart_recovered ONLY applies to working phases (prevents Opus L1)", () => {
    for (const p of ALL_NON_DONE_PHASES) {
      const res = stepPhase(p, "autonomous", { t: "restart_recovered" }, META);
      if (p.kind === "working") {
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.next.kind).toBe("queued");
      } else {
        expect(res.ok).toBe(false);
      }
    }
  });

  it("deriveControl gives stop precedence over paused (prevents Opus O1 oscillation)", () => {
    const labels = { stop: "factory:stop", paused: "factory:paused" };
    expect(deriveControl(["factory:paused", "factory:stop"], labels)).toBe("stopped");
    expect(deriveControl(["factory:paused"], labels)).toBe("paused");
    expect(deriveControl(["ready-for-agent"], labels)).toBe("run");
  });

  it("classifyGate fails closed on null/missing appSlug and picks latest check run by id", () => {
    const untrusted = classifyGate({
      requiredChecks: ["Gate"],
      checks: [{ id: 1, name: "Gate", status: "completed", conclusion: "success", appSlug: null }],
      since: 0,
      nudgedAt: null,
      now: 1000,
      graceMs: 5000,
      timeoutMs: 60_000,
    });
    expect(untrusted.status).toBe("untrusted");

    const latestWins = classifyGate({
      requiredChecks: ["Gate"],
      checks: [
        { id: 10, name: "Gate", status: "completed", conclusion: "failure", appSlug: "github-actions" },
        { id: 20, name: "Gate", status: "completed", conclusion: "success", appSlug: "github-actions" },
      ],
      since: 0,
      nudgedAt: null,
      now: 1000,
      graceMs: 5000,
      timeoutMs: 60_000,
    });
    expect(latestWins.status).toBe("green");
  });
});
