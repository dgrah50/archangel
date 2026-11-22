import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { Reconciler, describeCapUsage } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";

function seeded() {
  const l = new Ledger(":memory:", { repo: "acme/app" });
  const thread = (n: number) => l.upsertThread({ issueNumber: n, title: `SECRET TITLE ${n}`, bodySha256: "b", now: 1 });
  for (const n of [1, 2, 3]) thread(n);
  l.appendAudit("thread/owner_retry", 1, "owner", {}, 1); // everything before this does not count
  l.startAttempt(1, "implement", 2);
  l.startAttempt(2, "implement", 3);
  l.startAttempt(2, "revise", 4);
  l.startAttempt(2, "revise", 5);
  l.startAttempt(3, "implement", 6);
  l.startAttempt(3, "rebase", 7);
  l.appendAudit("thread/merged", 3, "archangel", {}, 8);
  const t1 = l.getThread(1)!;
  l.transition(1, t1.version, { kind: "needs_you", code: "gate_failed", reason: "SECRET REASON", resumeTo: { kind: "queued" } } as never, { now: 9 });
  return l;
}

describe("autonomy cap message", () => {
  it("lists what used the steps, per Thread, and what is waiting on the owner (counts and issue numbers only)", () => {
    const l = seeded();
    const b = l.autonomousStepBreakdown();
    expect(b.threads).toEqual([
      { issueNumber: 2, implement: 1, revise: 2, rebase: 0, merged: 0, total: 3 },
      { issueNumber: 3, implement: 1, revise: 0, rebase: 1, merged: 1, total: 3 },
      { issueNumber: 1, implement: 1, revise: 0, rebase: 0, merged: 0, total: 1 },
    ]);
    expect(b.needsYou).toEqual([1]);
    expect(b.threads.reduce((n, t) => n + t.total, 0)).toBe(l.autonomousStepsSinceOwner()); // the same steps the cap counts
    const text = describeCapUsage(b);
    expect(text).toContain("Used by 3 Thread(s):");
    expect(text).toContain("#2: 1 implement, 2 revise");
    expect(text).toContain("#3: 1 implement, 1 rebase, 1 merged");
    expect(text).toContain("Waiting on you: #1");
    expect(text).not.toContain("SECRET");
  });

  it("an owner action starts a new count, and a long list is cut with a total", () => {
    const l = new Ledger(":memory:", { repo: "acme/app" });
    for (let n = 1; n <= 14; n++) {
      l.upsertThread({ issueNumber: n, title: "t", bodySha256: "b", now: 1 });
      l.startAttempt(n, "implement", 2);
    }
    expect(describeCapUsage(l.autonomousStepBreakdown())).toContain("and 4 more Thread(s) (4 steps)");
    l.appendAudit("thread/owner_retry", 1, "owner", {}, 3);
    expect(l.autonomousStepBreakdown().threads).toEqual([]);
    expect(describeCapUsage(l.autonomousStepBreakdown())).toContain("Nothing is waiting on you.");
  });

  it("is what the cap's Needs You carries, once, and never raises the cap", async () => {
    const l = seeded();
    const notes: Array<{ reason: string }> = [];
    const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake", maxAutonomousStepsWithoutOwner: 3 });
    const rec = new Reconciler({
      config: cfg, ledger: l, github: new FakeGitHub("/nonexistent"), broker: {} as never,
      implementer: { async run() { throw new Error("unused"); } },
      reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
      notifier: { async notifyNeedsYou(i) { notes.push(i); }, async sendDigest() {} },
    });
    const reached = (rec as unknown as { autonomyCapReached: (n: number) => Promise<boolean> });
    expect(await reached.autonomyCapReached(100)).toBe(true);
    expect(await reached.autonomyCapReached(101)).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.reason).toContain("7 autonomous steps (cap 3)");
    expect(notes[0]!.reason).toContain("#2: 1 implement, 2 revise");
    expect(l.autonomousStepsSinceOwner()).toBe(7); // nothing reset or extended it
  });
});
