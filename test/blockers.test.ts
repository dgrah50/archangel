import { describe, expect, it } from "vitest";
import { parseStrictVerdict } from "../src/agents/reviewers.js";
import { computeBlockers, isShadowReady, type LandingSnapshot } from "../src/core/blockers.js";

function cleanSnapshot(overrides: Partial<LandingSnapshot> = {}): LandingSnapshot {
  return {
    prOpen: true,
    prDraft: false,
    headSha: "aaaa1111bbbb2222",
    shaRecordedByBroker: true,
    postHandoff: false,
    labels: ["ready-for-agent"],
    pauseLabel: "factory:paused",
    stopLabel: "factory:stop",
    circuitBreakerTripped: false,
    mainTipGreen: true,
    branchUpToDateWithMain: true,
    protectedFilesTouched: [],
    requiredChecks: ["Gate", "Test (ubuntu-latest)", "Test (macos-latest)"],
    checks: [
      { id: 1, name: "Gate", status: "completed", conclusion: "success", appSlug: "github-actions" },
      { id: 2, name: "Test (ubuntu-latest)", status: "completed", conclusion: "success", appSlug: "github-actions" },
      { id: 3, name: "Test (macos-latest)", status: "completed", conclusion: "success", appSlug: "github-actions" },
    ],
    reviewsForHeadSha: [
      {
        id: 1,
        repo: "dgrah50/gijq",
        issueNumber: 1,
        headSha: "aaaa1111bbbb2222",
        vendor: "openai",
        verdict: "approve",
        findingsJson: "[]",
        costUsd: 0.02,
        createdAt: 1,
      },
      {
        id: 2,
        repo: "dgrah50/gijq",
        issueNumber: 1,
        headSha: "aaaa1111bbbb2222",
        vendor: "gemini",
        verdict: "approve",
        findingsJson: "[]",
        costUsd: 0.02,
        createdAt: 1,
      },
    ],
    requiredReviewers: ["openai", "gemini"],
    mergeTreeClean: true,
    autoMergesToday: 0,
    maxAutoMergesPerDay: 3,
    shadowMode: false,
    ...overrides,
  };
}

describe("computeBlockers", () => {
  it("returns empty blockers when all mechanical gates and independent reviews pass", () => {
    expect(computeBlockers(cleanSnapshot())).toEqual([]);
  });

  it("detects shadow-ready cleanly when shadowMode is the only blocker", () => {
    const b = computeBlockers(cleanSnapshot({ shadowMode: true }));
    expect(isShadowReady(b)).toBe(true);
  });

  it("fails CLOSED on null appSlug and picks latest check run by highest id", () => {
    const bNull = computeBlockers(
      cleanSnapshot({
        checks: [
          { id: 1, name: "Gate", status: "completed", conclusion: "success", appSlug: null },
          { id: 2, name: "Test (ubuntu-latest)", status: "completed", conclusion: "success", appSlug: "github-actions" },
          { id: 3, name: "Test (macos-latest)", status: "completed", conclusion: "success", appSlug: "github-actions" },
        ],
      }),
    );
    expect(bNull.map((x) => x.code)).toContain("check_untrusted_source");

    const bDup = computeBlockers(
      cleanSnapshot({
        checks: [
          { id: 1, name: "Gate", status: "completed", conclusion: "failure", appSlug: "github-actions" },
          { id: 9, name: "Gate", status: "completed", conclusion: "success", appSlug: "github-actions" },
          { id: 2, name: "Test (ubuntu-latest)", status: "completed", conclusion: "success", appSlug: "github-actions" },
          { id: 3, name: "Test (macos-latest)", status: "completed", conclusion: "success", appSlug: "github-actions" },
        ],
      }),
    );
    expect(bDup).toEqual([]);
  });

  it("blocks untrusted check sources, unverified SHAs, post-handoff, red main, and vetoes", () => {
    const b = computeBlockers(
      cleanSnapshot({
        shaRecordedByBroker: false,
        postHandoff: true,
        circuitBreakerTripped: true,
        mainTipGreen: false,
        protectedFilesTouched: [".github/workflows/archangel-gate.yml"],
        checks: [
          { id: 1, name: "Gate", status: "completed", conclusion: "success", appSlug: "evil-app" },
          { id: 2, name: "Test (ubuntu-latest)", status: "in_progress", conclusion: null, appSlug: "github-actions" },
          { id: 3, name: "Test (macos-latest)", status: "completed", conclusion: "failure", appSlug: "github-actions" },
        ],
        reviewsForHeadSha: [
          {
            id: 1,
            repo: "dgrah50/gijq",
            issueNumber: 1,
            headSha: "aaaa1111bbbb2222",
            vendor: "openai",
            verdict: "veto",
            findingsJson: "[]",
            costUsd: 0,
            createdAt: 1,
          },
        ],
        mergeTreeClean: false,
        autoMergesToday: 3,
      }),
    );

    const codes = new Set(b.map((x) => x.code));
    expect(codes.has("unverified_head_sha")).toBe(true);
    expect(codes.has("post_handoff_owner_only")).toBe(true);
    expect(codes.has("circuit_breaker_tripped")).toBe(true);
    expect(codes.has("main_not_green")).toBe(true);
    expect(codes.has("protected_paths_touched")).toBe(true);
    expect(codes.has("check_untrusted_source")).toBe(true);
    expect(codes.has("check_pending")).toBe(true);
    expect(codes.has("check_failed")).toBe(true);
    expect(codes.has("review_vetoed")).toBe(true);
    expect(codes.has("review_missing")).toBe(true);
    expect(codes.has("merge_conflict")).toBe(true);
    expect(codes.has("daily_merge_cap_reached")).toBe(true);
  });
});

describe("parseStrictVerdict", () => {
  it("treats missing or unparseable model output as veto", () => {
    expect(parseStrictVerdict(undefined).verdict).toBe("veto");
    expect(parseStrictVerdict({ verdict: "maybe" }).verdict).toBe("veto");
    expect(parseStrictVerdict({ verdict: "approve", findings: [] }).verdict).toBe("approve");
  });
});
