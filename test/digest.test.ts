import { describe, expect, it, mock } from "bun:test";
import { sendDigestIfDue } from "../src/core/digest.js";
import { TelegramNotifier } from "../src/core/notifier.js";
import { stepPhase } from "../src/core/thread-machine.js";
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
  const esc = stepPhase(t.phase, t.mode, { t: "escalate", code: "review_vetoed", reason: "vetoed" }, { issueNumber: issue, title: t.title, needsYouLabel: "needs-you" });
  if (!esc.ok) throw new Error(esc.reject);
  view.transition(issue, t.version, esc.next, { now, repo });
}

describe("sendDigestIfDue", () => {
  it("sends once per local day across repos, after the digest hour, and survives a restart", async () => {
    const l = ledger();
    needsYouThread(l, "a/b", 1, NOW - 3 * HOUR);
    needsYouThread(l, "c/d", 2, NOW - 30 * HOUR);
    l.forRepo("a/b").recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h", shadowOnly: false, mainRequired: ["Test"], now: YESTERDAY, repo: "a/b" });
    const sendDigest = mock(async (_t: string) => {});
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
