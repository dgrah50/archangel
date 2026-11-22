import fs from "node:fs";
import path from "node:path";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildUiState } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";
import { AppView, type Feed } from "../ui/src/AppView.js";
import { NAV, parseRoute } from "../ui/src/route.js";

const NOW = 10 * 86_400_000;
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: el }));

describe("hash routes", () => {
  it("parses known pages and flags unknown ones", () => {
    expect(parseRoute("")).toEqual({ page: "overview" });
    expect(parseRoute("#/")).toEqual({ page: "overview" });
    expect(parseRoute("#/pipeline")).toEqual({ page: "pipeline" });
    expect(parseRoute("#/pipeline/")).toEqual({ page: "pipeline" });
    expect(parseRoute("#/threads")).toEqual({ page: "threads" });
    expect(parseRoute("#/needs-you")).toEqual({ page: "needs-you", item: null });
    expect(parseRoute("#/needs-you/a/b/7")).toEqual({ page: "needs-you", item: { repo: "a/b", issue: 7 } });
    expect(parseRoute("#/needs-you/a%20b/c/7").page).toBe("not-found");
    expect(parseRoute("#/nope")).toEqual({ page: "not-found", hash: "#/nope" });
  });
  it("every nav entry round-trips to its own page", () => {
    for (const n of NAV) expect(parseRoute(n.hash).page).toBe(n.page);
  });
});

describe("app shell", () => {
  const l = new Ledger(":memory:", { repo: "a/b" });
  l.setSystemState("daemon_lock", JSON.stringify({ ownerId: "x", pid: 1, heartbeatAt: NOW }), NOW);
  const state: Feed<ReturnType<typeof buildUiState>> = { data: buildUiState(l, NOW), at: NOW, error: null };
  const wfs = { data: null, at: null, error: null };
  const none = { data: null, at: null, error: null };
  const view = (route: Parameters<typeof parseRoute>[0]) => html(createElement(AppView, { route: parseRoute(route), state, workflows: wfs, host: none, thread: none, logs: none, now: NOW, onRetry: () => {} }));

  it("renders nav, daemon chip and the active page marker", () => {
    const out = view("#/");
    expect(out).toContain('aria-label="Pages"');
    expect(out).toContain('href="#/pipeline"');
    expect(out).toContain("daemon running");
    expect(out).toContain("Nothing needs you");
    expect(out).toMatch(/aria-current="page"[^>]*>Overview/);
  });
  it("shows Pipeline loading on its own page and an unknown hash as not found", () => {
    expect(view("#/pipeline")).toContain("Loading pipeline...");
    expect(view("#/zzz")).toContain("No such page.");
  });
});

describe("no raw HTML anywhere in the dashboard", () => {
  it("never uses dangerouslySetInnerHTML or innerHTML under ui/src", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const files = walk("ui/src").filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => /dangerouslySetInnerHTML|\.innerHTML/.test(fs.readFileSync(f, "utf8")))).toEqual([]);
  });
});
