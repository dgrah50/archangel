import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EvalReport } from "../src/core/eval.js";
import { REPORTS_KEEP, listReports, reportsDir, saveReport } from "../src/core/eval-reports.js";
import type { ReplayReport } from "../src/core/replay.js";
import { startUiServer } from "../src/core/ui-server.js";
import { Ledger } from "../src/ledger/store.js";
import { EVAL_CMD, EvalsPage } from "../ui/src/EvalsPage.js";
import { isEvalsState } from "../ui/src/payload.js";
import { parseRoute } from "../ui/src/route.js";

const NOW = 1_800_000_000_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "arc-eval-"));
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: el }));

const evalReport = (result: EvalReport["result"] = "pass"): EvalReport => ({
  split: "dev",
  candidate: { patchSha256: "abcdef0123456789", files: ["src/agents/prompts.ts"], touchesSkills: false },
  counts: { total: 12, dev: 7, heldout: 5, good: 6, bad: 6, disputes: 0, mutants: 2, unreplayable: 1, withoutIssueText: 0 },
  milestones: { current: 12, next: 20 },
  selected: 10,
  scored: { good: 5, bad: 5 },
  errors: 0,
  cacheHits: 0,
  baseline: { falseApprovals: [], falseVetoes: [] },
  candidateArm: { falseApprovals: ["x"], falseVetoes: [] },
  newFalseApprovals: ["x"],
  newFalseVetoes: [],
  fixedFalseApprovals: [],
  fixedFalseVetoes: [],
  allowedNewFalseVetoes: 0,
  result,
  reasons: result === "pass" ? [] : ["1 new false approval"],
});
const replayReport = (regressions: number): ReplayReport[] => [{ repo: "a/b", cases: [], mutants: [{ issueNumber: 1, mutator: "m", status: "rejected", detail: "" }], replayed: 3, regressions }];

describe("report persistence", () => {
  it("writes atomically as 0600, with no temp files left, and keeps the newest 20 per kind", () => {
    const dir = tmp();
    for (let i = 0; i < REPORTS_KEEP + 3; i++) saveReport(dir, "eval", evalReport(), NOW + i);
    saveReport(dir, "replay", replayReport(0), NOW);
    const files = fs.readdirSync(reportsDir(dir));
    expect(files.filter((f) => f.startsWith("eval-"))).toHaveLength(REPORTS_KEEP);
    expect(files.filter((f) => f.startsWith("replay-"))).toHaveLength(1);
    expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
    expect(files).not.toContain(`eval-${NOW}.json`);
    expect(fs.statSync(path.join(reportsDir(dir), `eval-${NOW + 22}.json`)).mode & 0o777).toBe(0o600);
  });
});

describe("listReports", () => {
  it("summarizes eval and replay runs newest first with verdicts", () => {
    const dir = tmp();
    saveReport(dir, "eval", evalReport("fail"), NOW);
    saveReport(dir, "eval", evalReport("insufficient"), NOW + 1);
    saveReport(dir, "replay", replayReport(2), NOW + 2);
    const s = listReports(dir, NOW + 10);
    expect(isEvalsState(s)).toBe(true);
    expect(s.runs.map((r) => (r.unreadable ? "?" : r.verdict))).toEqual(["fail", "INSUFFICIENT DATA", "fail"]);
    const replay = s.runs[0]!;
    expect(replay).toMatchObject({ kind: "replay", regressions: 2, replayed: 3, mutants: 1 });
    expect(s.runs[2]).toMatchObject({ kind: "eval", candidate: "abcdef012345", newFalseApprovals: 1, scored: 10, milestone: { current: 12, next: 20 } });
  });
  it("lists a corrupt or foreign file as unreadable instead of skipping it, and ignores unrelated files", () => {
    const dir = tmp();
    saveReport(dir, "eval", evalReport(), NOW);
    fs.writeFileSync(path.join(reportsDir(dir), `eval-${NOW + 1}.json`), "{not json");
    fs.writeFileSync(path.join(reportsDir(dir), `replay-${NOW + 2}.json`), JSON.stringify({ kind: "eval", report: {} }));
    fs.writeFileSync(path.join(reportsDir(dir), `eval-${NOW + 3}.json`), JSON.stringify({ kind: "eval", savedAt: 1, report: { candidate: {}, scored: {}, counts: {}, milestones: {} } }));
    fs.writeFileSync(path.join(reportsDir(dir), "notes.txt"), "x");
    const s = listReports(dir);
    expect(s.runs.filter((r) => r.unreadable)).toHaveLength(3);
    expect(s.runs).toHaveLength(4);
  });
  it("no data dir or no evals directory is simply empty", () => {
    expect(listReports(null).runs).toEqual([]);
    expect(listReports(tmp()).runs).toEqual([]);
  });
});

describe("GET /api/evals and the page", () => {
  it("serves the list and refuses writes", async () => {
    const ui = tmp();
    fs.writeFileSync(path.join(ui, "index.html"), "<html><head></head></html>");
    const dataDir = tmp();
    saveReport(dataDir, "eval", evalReport(), Date.now());
    const server = await startUiServer(new Ledger(":memory:"), { host: "127.0.0.1", port: 0, uiDir: ui, dataDir });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const body = (await (await fetch(`${base}/api/evals`)).json()) as { runs: unknown[] };
      expect(isEvalsState(body)).toBe(true);
      expect(body.runs).toHaveLength(1);
      expect((await fetch(`${base}/api/evals`, { method: "DELETE" })).status).toBe(405);
    } finally {
      server.close();
    }
  });
  const feed = (data: ReturnType<typeof listReports> | null, error: string | null = null) => ({ data, at: data ? NOW : null, error });
  const page = (f: ReturnType<typeof feed>) => html(createElement(EvalsPage, { evals: f, now: NOW + 3_600_000, onRetry: () => {} }));
  it("renders runs, an unreadable row, the empty command, loading and error", () => {
    const dir = tmp();
    saveReport(dir, "eval", evalReport("fail"), NOW);
    fs.writeFileSync(path.join(reportsDir(dir), `eval-${NOW + 1}.json`), "oops");
    const out = page(feed(listReports(dir)));
    expect(out).toContain("candidate abcdef012345");
    expect(out).toContain("1 new false approval");
    expect(out).toContain("8 to the next milestone (20)");
    expect(out).toContain("unreadable");
    expect(page(feed({ generatedAt: NOW, runs: [] }))).toContain(EVAL_CMD.replace("<", "&lt;").replace(">", "&gt;"));
    expect(page(feed(null))).toContain("Loading reports...");
    const err = page(feed(null, "/api/evals: boom"));
    expect(err).toContain("Reports unavailable.");
    expect(err).toContain("Retry");
    expect(page(feed({ generatedAt: NOW, runs: [] }, "x"))).toContain("showing the last loaded copy");
    expect(parseRoute("#/evals")).toEqual({ page: "evals" });
  });
});
