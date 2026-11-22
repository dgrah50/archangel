import { describe, expect, it } from "vitest";
import { buildDigest } from "../src/core/digest.js";

const NOW = Date.UTC(2026, 2, 10, 14);
const zero = { autonomousMerges: 0, ownerMerges: 0, reverts: 0, spendUsd: 0 };

describe("buildDigest quiet-day check", () => {
  it("keeps the digest when pitches could not be read", () => {
    const t = buildDigest({ now: NOW, needsYou: [], yesterday: zero, proposals: [], pitches: null });
    expect(t).not.toBeNull();
    expect(t).toContain("Pitches awaiting you: unavailable");
  });

  it("keeps the digest when Scout proposals are awaiting the owner", () => {
    const t = buildDigest({ now: NOW, needsYou: [], yesterday: zero, proposals: [{ repo: "a/b", issueNumber: 9, scoutName: "bug-hunt" }], pitches: [] });
    expect(t).toContain("a/b#9 (bug-hunt)");
  });

  it("keeps the digest when proposals could not be read", () => {
    const t = buildDigest({ now: NOW, needsYou: [], yesterday: zero, proposals: null, pitches: [] });
    expect(t).toContain("Scout proposals awaiting you: unavailable");
  });
});
