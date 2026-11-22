import { describe, expect, it, vi } from "vitest";
import { buildDigest, sendDigestIfDue } from "../src/core/digest.js";
import { TelegramNotifier } from "../src/core/notifier.js";
import { Ledger } from "../src/ledger/store.js";

const TZ = "America/New_York";
const HOUR = 3_600_000;
// 2026-03-10 14:00 UTC = 10:00 New York (EDT); yesterday is 2026-03-09.
const NOW = Date.UTC(2026, 2, 10, 14, 0, 0);
const YESTERDAY = NOW - 24 * HOUR;

function ledger() {
  return new Ledger(":memory:", { repo: "a/b", timeZone: TZ });
}

function needsYouThread(l: Ledger, repo: string, issue: number, now: number) {
  const view = l.forRepo(repo);
  const t = view.upsertThread({ issueNumber: issue, title: `Bug ${issue}`, bodySha256: `s${issue}`, now, repo });
  view.transition(
    issue,
    t.version,
    { kind: "needs_you", code: "review_vetoed", reason: "vetoed", resumeTo: { kind: "queued" } } as never,
    { now, repo },
  );
}

describe("buildDigest", () => {
  const quiet = { now: NOW, needsYou: [], yesterday: { autonomousMerges: 0, ownerMerges: 0, reverts: 0, spendUsd: 0 }, proposals: [], pitches: [], faults: [], draftReverts: [] };
  it("is not quiet when pitches or proposals could not be read, or are waiting on the owner", () => {
    expect(buildDigest({ ...quiet, pitches: null })).toContain("Pitches awaiting you: unavailable");
    expect(buildDigest({ ...quiet, proposals: null })).toContain("Scout proposals awaiting you: unavailable");
    expect(buildDigest({ ...quiet, proposals: [{ repo: "a/b", issueNumber: 9, scoutName: "bug-hunt" }] })).toContain("a/b#9 (bug-hunt)");
    expect(buildDigest({ ...quiet, pitches: [{ repo: "a/b", issueNumber: 8, scoutName: "pitch", since: NOW - HOUR }] })).toContain("a/b#8 (pitch)");
    expect(buildDigest(quiet)).toBeNull();
  });

});

describe("sendDigestIfDue", () => {
  it("sends nothing and records nothing on a quiet day", async () => {
    const l = ledger();
    const sendDigest = vi.fn(async () => {});
    expect(await sendDigestIfDue(l, { sendDigest }, { now: NOW, timeZone: TZ, digestHour: 9, openProposals: async () => new Set() })).toBe(false);
    expect(sendDigest).not.toHaveBeenCalled();
    l.close();
  });

  it("sends once per local day across repos, after the digest hour, and survives a restart", async () => {
    const l = ledger();
    needsYouThread(l, "a/b", 1, NOW - 3 * HOUR);
    needsYouThread(l, "c/d", 2, NOW - 30 * HOUR);
    l.forRepo("a/b").recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h", shadowOnly: false, mainRequired: ["Test"], now: YESTERDAY, repo: "a/b" });
    const sendDigest = vi.fn(async (_t: string) => {});
    const opts = { timeZone: TZ, digestHour: 9, openProposals: async () => new Set<string>() };

    expect(await sendDigestIfDue(l, { sendDigest }, { ...opts, now: Date.UTC(2026, 2, 10, 12, 0, 0) })).toBe(false); // 08:00 local, too early
    expect(await sendDigestIfDue(l, { sendDigest }, { ...opts, now: NOW })).toBe(true);
    expect(sendDigest).toHaveBeenCalledTimes(1);
    const text = sendDigest.mock.calls[0]![0];
    expect(text).toContain("a/b#1");
    expect(text).toContain("c/d#2");
    expect(text).toContain("Merges: 1 autonomous");

    expect(await sendDigestIfDue(l, { sendDigest }, { ...opts, now: NOW + HOUR })).toBe(false);
    expect(sendDigest).toHaveBeenCalledTimes(1);
    // Next local day sends again.
    expect(await sendDigestIfDue(l, { sendDigest }, { ...opts, now: NOW + 24 * HOUR })).toBe(true);
    expect(sendDigest).toHaveBeenCalledTimes(2);
    l.close();
  });
});

describe("digest Scout proposals", () => {
  it("lists only proposals whose issue is still open with the agent-proposed label", async () => {
    const l = ledger();
    needsYouThread(l, "a/b", 1, NOW - HOUR);
    for (const n of [10, 11, 12]) l.recordScoutProposal({ issueNumber: n, scoutName: "bug-hunt", contentSha256: `c${n}`, titleFp: `t${n}`, repo: "a/b" });
    const sendDigest = vi.fn(async (_t: string) => {});
    // #10 open, #11 closed by the owner, #12 had its label removed.
    await sendDigestIfDue(l, { sendDigest }, { now: NOW, timeZone: TZ, digestHour: 9, openProposals: async () => new Set(["a/b#10"]) });
    const text = sendDigest.mock.calls[0]![0];
    expect(text).toContain("a/b#10 (bug-hunt)");
    expect(text).not.toContain("a/b#11");
    expect(text).not.toContain("a/b#12");
    l.close();
  });
});
