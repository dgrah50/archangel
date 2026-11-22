import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildUiState } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";
import { Dashboard } from "../ui/src/Dashboard.js";
import { NeedsYouPage, nextItem } from "../ui/src/NeedsYouPage.js";
import { ThreadsPage } from "../ui/src/ThreadsPage.js";

const NOW = 10 * 86_400_000;
const EVIL = "<script>alert(1)</script>";

describe("Dashboard", () => {
  it("renders an untrusted <script> title as text, links to GitHub, and has no controls", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const t = l.upsertThread({ issueNumber: 1, title: EVIL, bodySha256: "s", now: NOW - 3_600_000 });
    l.transition(1, t.version, { kind: "needs_you", code: "review_vetoed", reason: "x", resumeTo: { kind: "queued" } } as never, { now: NOW - 3_600_000 });
    const html = renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: createElement(NeedsYouPage, { state: buildUiState(l, NOW), item: null }) }));
    expect(html).not.toContain(EVIL);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('href="https://github.com/a/b/issues/1"');
    expect(html).not.toContain("<form");
    // Actions are a link to GitHub and a copy button: nothing posts.
    expect(html).toContain("Answer on GitHub");
    expect(html).toContain("Copy /archangel retry");
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

  it("shows stat tiles on Overview, and the Threads page hides empty groups and folds Done and Queued", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const mk = (n: number, title: string, phase: Parameters<Ledger["transition"]>[2] | null) => {
      const t = l.upsertThread({ issueNumber: n, title, bodySha256: `s${n}`, now: NOW - 3_600_000 });
      if (phase) l.transition(n, t.version, phase, { now: NOW - 3_600_000 });
    };
    mk(1, "queued one", null);
    mk(2, "shipped", { kind: "done", outcome: "merged" });
    mk(3, "closed", { kind: "done", outcome: "pr_closed" });
    const state = buildUiState(l, NOW);
    const overview = renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: createElement(Dashboard, { state }) }));
    for (const label of ["Repos", "Merged today", "Needs You"]) expect(overview).toContain(label);
    const html = renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: createElement(ThreadsPage, { state }) }));
    expect(html).toContain("Queued");
    expect(html).not.toContain("Waiting on CI");
    expect(html).not.toContain("In review");
    expect(html).toMatch(/<details[^>]*>.*Done in last 7 days.*>2</);
    expect(html).not.toMatch(/<details[^>]*open[^>]*>[^]*Done in last 7 days/);
    expect(html).toContain("PR closed");
  });

  it("Next walks the queue and wraps; an unknown item says it no longer needs you", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    for (const n of [1, 2]) {
      const t = l.upsertThread({ issueNumber: n, title: `t${n}`, bodySha256: `s${n}`, now: NOW - n * 3_600_000 });
      l.transition(n, t.version, { kind: "needs_you", code: "review_vetoed", reason: "x", resumeTo: { kind: "queued" } } as never, { now: NOW - n * 3_600_000 });
    }
    const state = buildUiState(l, NOW);
    expect(state.needsYou.map((i) => i.issueNumber)).toEqual([2, 1]);
    expect(nextItem(state.needsYou, state.needsYou[0]!)).toBe(state.needsYou[1]);
    expect(nextItem(state.needsYou, state.needsYou[1]!)).toBe(state.needsYou[0]);
    expect(nextItem(state.needsYou.slice(0, 1), state.needsYou[0]!)).toBeNull();
    const html = renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: createElement(NeedsYouPage, { state, item: { repo: "a/b", issue: 99 } }) }));
    expect(html).toContain("That item no longer needs you.");
  });
});
