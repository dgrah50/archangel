import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildUiState } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";
import { Dashboard } from "../ui/src/Dashboard.js";

const NOW = 10 * 86_400_000;
const EVIL = "<script>alert(1)</script>";

describe("Dashboard", () => {
  it("renders an untrusted <script> title as text, links to GitHub, and has no controls", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const t = l.upsertThread({ issueNumber: 1, title: EVIL, bodySha256: "s", now: NOW - 3_600_000 });
    l.transition(1, t.version, { kind: "needs_you", code: "review_vetoed", reason: "x", resumeTo: { kind: "queued" } } as never, { now: NOW - 3_600_000 });
    const html = renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: createElement(Dashboard, { state: buildUiState(l, NOW) }) }));
    expect(html).not.toContain(EVIL);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('href="https://github.com/a/b/issues/1"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });

  it("rounds per-fix ratios to one decimal and labels the chart's first and last day", () => {
    const state = buildUiState(new Ledger(":memory:"), NOW);
    state.outcomes = { ...state.outcomes, mergedFixes: 11, attemptsPerFix: 1.636, revertsPerFix: 0.0909, costUsdPerFix: 0.12345 };
    const html = renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: createElement(Dashboard, { state }) }));
    expect(html).toContain("Attempts: 1.6,");
    expect(html).not.toContain("1.636");
    expect(html).toContain("Reverts: 0.1 ");
    expect(html).toContain("$0.12");
    expect(html).toContain(`<span>${state.daily[0]!.day.slice(5)}</span>`);
    expect(html).toContain(`<span>${state.daily[13]!.day.slice(5)}</span>`);
  });

  it("shows stat tiles, hides empty stage groups, and collapses Done behind its count", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const mk = (n: number, title: string, phase: Parameters<Ledger["transition"]>[2] | null) => {
      const t = l.upsertThread({ issueNumber: n, title, bodySha256: `s${n}`, now: NOW - 3_600_000 });
      if (phase) l.transition(n, t.version, phase, { now: NOW - 3_600_000 });
    };
    mk(1, "queued one", null);
    mk(2, "shipped", { kind: "done", outcome: "merged" });
    mk(3, "closed", { kind: "done", outcome: "pr_closed" });
    const html = renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: createElement(Dashboard, { state: buildUiState(l, NOW) }) }));
    for (const label of ["Repos", "Merged today", "Needs You"]) expect(html).toContain(label);
    expect(html).toContain("Nothing needs you.");
    expect(html).toContain("Queued");
    expect(html).not.toContain("Waiting on CI");
    expect(html).not.toContain("In review");
    expect(html).toMatch(/<details[^>]*>.*Done in last 7 days.*>2</);
    expect(html).toContain("PR closed");
    expect(html).not.toContain("<button");
  });
});
