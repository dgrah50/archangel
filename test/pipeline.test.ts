import { describe, expect, it } from "bun:test";
import { Ledger } from "../src/ledger/store.js";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const SINCE = NOW - 14 * DAY;

function seed(l: Ledger) {
  const mk = (n: number, branch: string, phase: object | null, at = NOW - DAY, wf: string | null = "wf1") => {
    l.upsertThread({ issueNumber: n, title: `t${n}`, bodySha256: "x", branchName: branch, now: at, workflowSha256: wf, ...(phase ? { phase: phase as never } : {}) });
  };
  mk(1, "factory/1", { kind: "done", outcome: "merged" });
  mk(2, "factory/feature-2", { kind: "done", outcome: "owner_merged" });
  mk(3, "factory/3", { kind: "done", outcome: "reverted" }, NOW - DAY, "wf2");
  mk(4, "factory/4", null, NOW - 2 * DAY);
  mk(5, "factory/5", { kind: "needs_you", code: "gate_failed", reason: "r", resumeTo: { kind: "queued" } }, NOW - DAY, null);
  mk(6, "factory/6", null, NOW - 30 * DAY); // outside the window
  for (const n of [1, 1, 3]) {
    const a = l.startAttempt(n, "implement", NOW - DAY);
    l.finishAttempt(a.id, n === 3 ? { status: "failed", errorMessage: "x", errorCategory: "other" } : { status: "succeeded" });
  }
  l.recordReview({ issueNumber: 1, headSha: "h", vendor: "openai", verdict: "approve", findings: [], costUsd: 0, now: NOW - DAY });
  l.recordReview({ issueNumber: 1, headSha: "h", vendor: "gemini", verdict: "veto", findings: [], costUsd: 0, now: NOW - DAY });
  l.recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h", squashSha: "s", shadowOnly: false, mainRequired: ["Test"], now: NOW - DAY });
  l.recordScoutProposal({ issueNumber: 1, scoutName: "bug-hunt", contentSha256: "c", titleFp: "f", autoPromoted: true, now: NOW - 3_600_000 });
  l.recordScoutProposal({ issueNumber: 99, scoutName: "bug-hunt", contentSha256: "c2", titleFp: "f2", now: NOW - DAY });
  l.appendAudit("scout/run", null, "bug-hunt", { dayKey: "d" }, NOW - DAY);
  l.appendAudit("scout/secret_blocked", null, "bug-hunt", {}, NOW - DAY);
  l.appendAudit("intake/rejected_label_actor", 7, "archangel", {}, NOW - DAY);
  l.appendAudit("review/outage_started", 1, "archangel", {}, NOW - DAY);
}

describe("Ledger.computeStageMetrics", () => {
  it("computes each stage's figures over the window only", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    seed(l);
    const m = l.computeStageMetrics("a/b", SINCE, NOW);
    expect(m.intake).toMatchObject({ queued: 1, rejections: { label_actor: 1 } });
    expect(m.scouts["bug-hunt"]).toEqual({ runs: 1, secretsBlocked: 1, filed: 2, becameThread: 1, merged: 1, reverted: 0 });
    expect(m.promotion).toEqual({ autoPromotionsLast24h: 1, autoPromotionsInWindow: 1 });
    expect(m.workClass.bugfix).toMatchObject({ merged: 2, attemptsPerMerge: 1.5 });
    expect(m.workClass.feature).toMatchObject({ threads: 1, merged: 1 });
    expect(m.gate.attempts).toEqual({ total: 3, succeeded: 2, failed: 1 });
    expect(m.gate.escalations).toEqual({ gate_failed: 1 });
    expect(m.review).toEqual({ byVendor: { openai: { approve: 1, veto: 0 }, gemini: { approve: 0, veto: 1 } }, outages: 1 });
    expect(m.landing).toMatchObject({ autoMerged: 1, ownerMerged: 1 });
    expect(m.needsYou.byDecisionClass).toEqual({ live_infrastructure: 1 });
    expect(m.byWorkflowSha.wf1).toEqual({ threads: 3, merged: 2, reverted: 0 });
    expect(m.byWorkflowSha.wf2).toEqual({ threads: 1, merged: 1, reverted: 1 });
    expect(m.byWorkflowSha.none).toEqual({ threads: 1, merged: 0, reverted: 0 });
    expect(Object.values(m.byWorkflowSha).reduce((a, b) => a + b.threads, 0)).toBe(5); // the 30-day-old Thread is excluded
    l.close();
  });
});
