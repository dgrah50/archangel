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
        repo: "acme/app",
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
        repo: "acme/app",
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

describe("landing fail-closed invariants", () => {
  it("fails closed on null/untrusted appSlug and deduplicates check runs by highest id", () => {
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

    const bEvil = computeBlockers(
      cleanSnapshot({
        checks: [
          { id: 1, name: "Gate", status: "completed", conclusion: "success", appSlug: "third-party-bot" },
          { id: 2, name: "Test (ubuntu-latest)", status: "completed", conclusion: "success", appSlug: "github-actions" },
          { id: 3, name: "Test (macos-latest)", status: "completed", conclusion: "success", appSlug: "github-actions" },
        ],
      }),
    );
    expect(bEvil.map((x) => x.code)).toContain("check_untrusted_source");

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

  it("treats shadowMode as the sole shadow-ready blocker, never masking real blockers", () => {
    expect(isShadowReady(computeBlockers(cleanSnapshot({ shadowMode: true })))).toBe(true);
    expect(isShadowReady(computeBlockers(cleanSnapshot({ shadowMode: true, shaRecordedByBroker: false })))).toBe(false);
    expect(isShadowReady(computeBlockers(cleanSnapshot({ shadowMode: true, postHandoff: true })))).toBe(false);
  });

  it("treats missing or unparseable reviewer output as veto", () => {
    expect(parseStrictVerdict(undefined).verdict).toBe("veto");
    expect(parseStrictVerdict({ verdict: "maybe" }).verdict).toBe("veto");
    expect(parseStrictVerdict({ verdict: "approve", findings: [] }).verdict).toBe("approve");
  });
});
