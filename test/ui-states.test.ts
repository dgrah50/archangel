import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startUiServer } from "../src/core/ui-server.js";
import { buildUiState, buildWorkflowsState, type UiState, type WorkflowsState } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";
import { AppView, DAEMON_OFFLINE_MS, STALE_MS, bannersFor, type Feed } from "../ui/src/AppView.js";
import type { Route } from "../ui/src/route.js";
import { ErrorBoundary } from "../ui/src/ErrorBoundary.js";
import { fetchFeed, isUiState, isWorkflowsState } from "../ui/src/payload.js";

const NOW = 10 * 86_400_000;
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: el }));

function liveState(heartbeat: number | null = NOW - 5_000): UiState {
  const l = new Ledger(":memory:", { repo: "a/b" });
  const t = l.upsertThread({ issueNumber: 1, title: "needs help", bodySha256: "s", now: NOW - 3_600_000 });
  l.transition(1, t.version, { kind: "needs_you", code: "review_vetoed", reason: "x", resumeTo: { kind: "queued" } } as never, { now: NOW - 3_600_000 });
  if (heartbeat !== null) l.setSystemState("daemon_lock", JSON.stringify({ ownerId: "x", pid: 1, heartbeatAt: heartbeat }), NOW);
  return buildUiState(l, NOW);
}
const wfs: WorkflowsState = { generatedAt: NOW, windowDays: 14, repos: [] };
const feed = <T = never,>(data: T | null, at: number | null, error: string | null = null): Feed<T> => ({ data, at, error });
const noState = (error: string | null = null) => feed<UiState>(null, null, error);
const noWfs = (error: string | null = null) => feed<WorkflowsState>(null, null, error);
const view = (state: Feed<UiState>, workflows: Feed<WorkflowsState>, now = NOW, route: Route = { page: "overview" }) =>
  html(createElement(AppView, { route, state, workflows, thread: { data: null, at: null, error: null }, logs: { data: null, at: null, error: null }, now, onRetry: () => {} }));
const pipelineView = (state: Feed<UiState>, workflows: Feed<WorkflowsState>) => view(state, workflows, NOW, { page: "pipeline" });

describe("dashboard states are distinct", () => {
  it("loading", () => {
    const out = view(noState(), noWfs());
    expect(out).toContain("Loading...");
    expect(out).not.toContain("Nothing needs you");
    expect(out).not.toContain('role="alert"');
  });

  it("error with no data: an alert with the reason and Retry, never a blank or zero dashboard", () => {
    const out = view(noState("/api/state: HTTP 500"), noWfs());
    expect(out).toContain("Cannot load the dashboard.");
    expect(out).toContain("/api/state: HTTP 500");
    expect(out).toContain("Retry");
    expect(out).not.toContain("Merged today");
  });

  it("ready and empty: a healthy empty dashboard shows its calm empty state and no banners", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    l.setSystemState("daemon_lock", JSON.stringify({ ownerId: "x", pid: 1, heartbeatAt: NOW }), NOW);
    const out = view(feed(buildUiState(l, NOW), NOW), feed(wfs, NOW));
    expect(out).toContain("Nothing needs you");
    expect(out).not.toContain('role="alert"');
  });

  it("failed refresh with old data: shows the data plus a red banner saying how old it is", () => {
    const out = view(feed(liveState(), NOW - 120_000, "/api/state: HTTP 500"), feed(wfs, NOW));
    expect(out).toContain("1 need you");
    expect(out).toContain("Refresh failed (/api/state: HTTP 500). Showing data from 2m ago; it may be out of date.");
  });

  it("stale data without an error: an orange stale banner after two poll intervals", () => {
    expect(bannersFor(feed(liveState(), NOW - STALE_MS + 1_000), NOW).map((b) => b.text)).toEqual([]);
    const stale = bannersFor(feed(liveState(), NOW - STALE_MS - 5_000), NOW);
    expect(stale).toEqual([{ tone: "orange", text: "Data is stale: last updated 35s ago." }]);
  });

  it("daemon offline: no lock at all, or an old heartbeat", () => {
    expect(view(feed(liveState(null), NOW), feed(wfs, NOW))).toContain("Daemon offline: no daemon lock is held");
    const old = view(feed(liveState(NOW - DAEMON_OFFLINE_MS - 120_000), NOW), feed(wfs, NOW));
    expect(old).toContain("Daemon offline? Last heartbeat 5m ago");
    expect(view(feed(liveState(NOW - 10_000), NOW), feed(wfs, NOW))).not.toContain("Daemon offline");
  });

  it("a failed /api/workflows does not hide the shell: the header still shows Needs You and only the Pipeline page shows an error with Retry", () => {
    const out = pipelineView(feed(liveState(), NOW), noWfs("/api/workflows: boom"));
    expect(out).toContain("1 need you");
    expect(out).toContain("Pipeline unavailable.");
    expect(out).toContain("/api/workflows: boom");
    expect(out).toContain("Retry");
    expect(pipelineView(feed(liveState(), NOW), noWfs())).toContain("Loading pipeline...");
  });

  it("a workflows refresh that failed after a good load keeps the last copy with a notice", () => {
    const out = pipelineView(feed(liveState(), NOW), feed(wfs, NOW, "/api/workflows: HTTP 500"));
    expect(out).toContain("Pipeline refresh failed (/api/workflows: HTTP 500); showing the last loaded copy.");
  });
});

describe("ErrorBoundary", () => {
  it("renders an alert with the message instead of a blank page", () => {
    const eb = new ErrorBoundary({ children: null });
    eb.state = ErrorBoundary.getDerivedStateFromError(new Error("bad payload"));
    const out = html(eb.render() as ReturnType<typeof createElement>);
    expect(out).toContain('role="alert"');
    expect(out).toContain("bad payload");
  });
  it("passes children through when nothing failed", () => {
    expect(html(createElement(ErrorBoundary, null, createElement("p", null, "fine")))).toContain("fine");
  });
});

describe("corrupt or partial API data is an error, not blank or zero", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (body: string, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

  it("the guards accept real payloads and reject partial ones", () => {
    expect(isUiState(liveState())).toBe(true);
    expect(isUiState({ ...liveState(), stages: {} })).toBe(false);
    expect(isUiState({ ...liveState(), outcomes: null })).toBe(false);
    expect(isUiState(null)).toBe(false);
    const l = new Ledger(":memory:", { repo: "a/b" });
    expect(isWorkflowsState(buildWorkflowsState(l))).toBe(true);
    expect(isWorkflowsState({ generatedAt: 1, windowDays: 14 })).toBe(false);
  });

  it("fetchFeed throws a descriptive error for a non-JSON reply, an API error, and a wrong shape", async () => {
    stub("<html>proxy error</html>", 502);
    await expect(fetchFeed("/api/state", isUiState)).rejects.toThrow("/api/state: HTTP 502, reply is not JSON");
    stub(JSON.stringify({ error: "db locked" }), 500);
    await expect(fetchFeed("/api/state", isUiState)).rejects.toThrow("/api/state: db locked");
    stub(JSON.stringify({ generatedAt: 1 }));
    await expect(fetchFeed("/api/state", isUiState)).rejects.toThrow("unexpected data shape");
    stub(JSON.stringify(liveState()));
    await expect(fetchFeed("/api/state", isUiState)).resolves.toMatchObject({ generatedAt: NOW });
  });
});

describe("server: API errors are JSON", () => {
  it("answers /api/* failures with a JSON error, and a malformed URL with 400", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-ui-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head></html>");
    const broken = { listAllThreads: () => { throw new Error("corrupt row"); } } as unknown as Ledger;
    const server = await startUiServer(broken, { host: "127.0.0.1", port: 0, uiDir: dir });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/api/state`);
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toEqual({ error: "corrupt row" });
      const bad = await fetch(`${base}/api/%E0%A4%A`);
      expect(bad.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
