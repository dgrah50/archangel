import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolveWorkflow, type EffectiveWorkflow, type HostWorkflowInput } from "../src/core/workflow.js";
import { startUiServer } from "../src/core/ui-server.js";
import { buildWorkflowsState, describeWorkflow } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";
import { Pipeline } from "../ui/src/Pipeline.js";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const SINCE = NOW - 14 * DAY;

const FILE = JSON.stringify({
  version: 1,
  gate: { testFileGlobs: ["**/*.test.ts"], testCmd: "npm test" },
  requiredChecks: ["Gate", "Test"],
  landing: { bugfix: "autonomous" },
  scouts: [{ name: "bug-hunt", promotion: "auto" }],
});
const host = (over: Partial<HostWorkflowInput> = {}): HostWorkflowInput => ({
  shadowMode: true,
  maxAutoMergesPerDay: 3,
  maxAutoPromotionsPerDay: 1,
  scoutRunsPerDay: 2,
  maxConcurrentThreads: 2,
  isRevoked: () => false,
  ...over,
});
const resolve = (over: Partial<HostWorkflowInput> = {}, fileRaw: string | null = FILE): EffectiveWorkflow =>
  resolveWorkflow(host(over), { repo: "a/b", mainSha: "m".repeat(40), fileRaw, scoutPrompts: { "bug-hunt": "Find bugs. SECRET-PROMPT-TEXT" } });

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
    l.finishAttempt(a.id, { status: n === 3 ? "failed" : "succeeded" });
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

describe("workflows state", () => {
  it("shows the clamp note and source chips for an ok workflow, without Scout prompt text", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const r = describeWorkflow("a/b", resolve(), l.computeStageMetrics("a/b", SINCE, NOW));
    expect(r.status).toBe("ok");
    const landing = r.stages.find((s) => s.id === "landing")!;
    expect(landing.clamps).toEqual(["bugfix landing: repo says autonomous, host shadowMode caps at owner"]);
    expect(landing.items.find((i) => i.label === "bugfix")).toMatchObject({ value: "owner", source: "host" });
    expect(landing.items.find((i) => i.label === "feature")).toMatchObject({ source: "kernel" });
    expect(r.stages.find((s) => s.id === "gate")!.items.find((i) => i.label === "required checks")).toMatchObject({ source: "repo" });
    expect(JSON.stringify(r)).not.toContain("SECRET-PROMPT-TEXT");
    l.close();
  });

  it("reports missing and invalid as halted states, and unresolved when the daemon has not run", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const m = l.computeStageMetrics("a/b", SINCE, NOW);
    expect(describeWorkflow("a/b", resolve({}, null), m)).toMatchObject({ status: "missing" });
    const bad = describeWorkflow("a/b", resolve({}, '{"version":1}'), m);
    expect(bad.status).toBe("invalid");
    expect(bad.error).toBeTruthy();
    expect(describeWorkflow("a/b", null, m).status).toBe("unresolved");
    l.close();
  });

  it("builds from the cached workflows plus repos that only have Threads", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    l.setSystemState("workflow:a/b", JSON.stringify(resolve()));
    l.forRepo("c/d").upsertThread({ issueNumber: 1, title: "t", bodySha256: "x", now: NOW });
    const s = buildWorkflowsState(l, NOW);
    expect(s.repos.map((r) => [r.repo, r.status])).toEqual([["a/b", "ok"], ["c/d", "unresolved"]]);
    expect(s.windowDays).toBe(14);
    l.close();
  });
});

describe("/api/workflows and the Pipeline view", () => {
  it("serves the state read-only on loopback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-ui-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<div id=root></div>");
    const l = new Ledger(":memory:", { repo: "a/b" });
    l.setSystemState("workflow:a/b", JSON.stringify(resolve()));
    const server = await startUiServer(l, { host: "127.0.0.1", port: 0, uiDir: dir });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const body = await fetch(`${base}/api/workflows`).then((r) => r.json());
      expect(body.repos[0]).toMatchObject({ repo: "a/b", status: "ok" });
      expect((await fetch(`${base}/api/workflows`, { method: "POST" })).status).toBe(405);
    } finally {
      server.close();
    }
  });

  const render = (data: ReturnType<typeof buildWorkflowsState>) =>
    renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: createElement(Pipeline, { data }) }));

  it("renders the clamp note and source chips", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    l.setSystemState("workflow:a/b", JSON.stringify(resolve()));
    const html = render(buildWorkflowsState(l, NOW));
    expect(html).toContain("Clamped: bugfix landing: repo says autonomous, host shadowMode caps at owner");
    for (const chip of ["kernel", "host", "repo"]) expect(html).toContain(`>${chip}</span>`);
    l.close();
  });

  it("renders the missing state as halted, and escapes untrusted text", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    l.setSystemState("workflow:a/b", JSON.stringify(resolve({}, null)));
    expect(render(buildWorkflowsState(l, NOW))).toContain("Workflow file missing: this repo is halted");
    l.setSystemState("workflow:a/b", JSON.stringify({ repo: "a/b", mainSha: "m", status: "invalid", fileSha256: "f".repeat(64), error: "<script>alert(1)</script>" }));
    const html = render(buildWorkflowsState(l, NOW));
    expect(html).toContain("Workflow file invalid: this repo is halted");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    l.close();
  });
});
