import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DoctorReport } from "../src/core/doctor.js";
import { makeDoctorHandler, redactSecrets } from "../src/core/ui-doctor.js";
import { startUiServer } from "../src/core/ui-server.js";
import { Ledger } from "../src/ledger/store.js";
import { FaultsPanel, HealthPage, LadderView, commandIn } from "../ui/src/HealthPage.js";
import { parseRoute } from "../ui/src/route.js";

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: el }));
const SECRET = "sk-live-0123456789abcdef";
const report: DoctorReport = {
  ok: true,
  checks: [
    { id: "git", name: "Git Version", status: "pass", detail: "git version 2.45", scope: "machine" },
    { id: "api", name: "Keys", status: "fail", detail: `bad key ${SECRET}`, remediation: "Run `gh auth login`", scope: "machine" },
    { id: "gate_workflow:a/b", name: "Gate", status: "warn", detail: "missing", scope: "repo" },
  ],
};

describe("doctor handler", () => {
  it("splits machine and repo checks and redacts secret env values from every string", async () => {
    const h = makeDoctorHandler(async () => report, { ANTHROPIC_API_KEY: SECRET, SHORT_KEY: "abc" });
    const m = await h("machine", false);
    expect(m.checks.map((c) => c.id)).toEqual(["git", "api"]);
    expect(m.ok).toBe(false);
    expect(JSON.stringify(m)).not.toContain(SECRET);
    expect(m.checks[1]!.detail).toBe("bad key <ANTHROPIC_API_KEY>");
    expect((await h("repo", false)).checks.map((c) => c.id)).toEqual(["gate_workflow:a/b"]);
  });
  it("caches non-smoke runs for 30s, shares in-flight runs, and never caches smoke", async () => {
    const run = vi.fn(async () => report);
    const h = makeDoctorHandler(run, {});
    await Promise.all([h("machine", false, 1000), h("machine", false, 1000)]);
    await h("machine", false, 2000);
    expect(run).toHaveBeenCalledTimes(1);
    await h("machine", false, 40_000);
    expect(run).toHaveBeenCalledTimes(2);
    await h("machine", true, 40_000);
    await h("machine", true, 40_001);
    expect(run).toHaveBeenCalledTimes(4);
  });
  it("redactSecrets ignores short and non-secret-named values", () => {
    expect(redactSecrets("home /Users/x abc", { HOME: "/Users/x", SHORT_TOKEN: "abc" })).toBe("home /Users/x abc");
  });
});

describe("GET /api/doctor", () => {
  const start = async (opts: { allowRemote?: boolean; doctor?: boolean }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-doc-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head></html>");
    const run = vi.fn(async () => report);
    const server = await startUiServer(new Ledger(":memory:"), { host: "127.0.0.1", port: 0, uiDir: dir, allowRemote: opts.allowRemote, ...(opts.doctor === false ? {} : { doctor: run }) });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = await (await fetch(base)).text();
    return { server, base, run, token: /name="archangel-token" content="([0-9a-f]+)"/.exec(page)?.[1] ?? null };
  };
  it("machine needs no token; smoke and repo need it; bad scope is 400; writes are 405", async () => {
    const { server, base, run, token } = await start({});
    try {
      expect(token).not.toBeNull();
      expect((await fetch(`${base}/api/doctor?scope=machine`)).status).toBe(200);
      expect((await fetch(`${base}/api/doctor?scope=machine&smoke=1`)).status).toBe(401);
      expect((await fetch(`${base}/api/doctor?scope=repo`)).status).toBe(401);
      expect((await fetch(`${base}/api/doctor?scope=repo`, { headers: { "x-archangel-token": "wrong" } })).status).toBe(401);
      expect((await fetch(`${base}/api/doctor?scope=repo`, { headers: { "x-archangel-token": token! } })).status).toBe(200);
      expect((await fetch(`${base}/api/doctor?scope=machine&smoke=1`, { headers: { "x-archangel-token": token! } })).status).toBe(200);
      expect((await fetch(`${base}/api/doctor?scope=nope`)).status).toBe(400);
      expect((await fetch(`${base}/api/doctor?scope=machine`, { method: "POST" })).status).toBe(405);
      expect(run).toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
  it("remote mode serves only the plain machine ladder: no token embedded, smoke and repo are 403", async () => {
    const { server, base, token } = await start({ allowRemote: true });
    try {
      expect(token).toBeNull();
      expect((await fetch(`${base}/api/doctor?scope=machine`)).status).toBe(200);
      expect((await fetch(`${base}/api/doctor?scope=machine&smoke=1`)).status).toBe(403);
      expect((await fetch(`${base}/api/doctor?scope=repo`)).status).toBe(403);
    } finally {
      server.close();
    }
  });
  it("is 404 when no doctor is wired", async () => {
    const { server, base } = await start({ doctor: false });
    try {
      expect((await fetch(`${base}/api/doctor?scope=machine`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("Health page", () => {
  const noop = () => {};
  const view = (ladder: Parameters<typeof LadderView>[0]["ladder"], disabledReason?: string) => html(createElement(LadderView, { title: "This machine", hint: "hint", ladder, onRun: noop, runLabel: "Recheck", disabledReason }));
  it("renders idle, running, error and result states", () => {
    expect(view({ state: "idle" })).toContain("Not run yet.");
    expect(view({ state: "running" })).toContain("Running...");
    const err = view({ state: "error", message: "HTTP 500" });
    expect(err).toContain('role="alert"');
    expect(err).toContain("HTTP 500");
    expect(err).toContain("Recheck");
    const done = view({ state: "done", payload: { generatedAt: 1, scope: "machine", smoke: false, ok: false, checks: report.checks.slice(0, 2) } });
    expect(done).toContain("Git Version");
    expect(done).toContain("fail");
    expect(done).toContain("Copy command");
    expect(view({ state: "done", payload: { generatedAt: 1, scope: "repo", smoke: false, ok: true, checks: [] } })).toContain("No checks reported.");
  });
  it("disables a run button with its reason", () => {
    const out = view({ state: "idle" }, "Needs the local dashboard");
    expect(out).toContain("Needs the local dashboard");
    expect(out).toMatch(/<button[^>]*disabled/);
  });
  it("the page renders its three ladders and routes", () => {
    const out = html(createElement(HealthPage, { faults: [], now: 1000 }));
    for (const t of ["This machine", "Subscription CLIs (smoke)", "GitHub wiring"]) expect(out).toContain(t);
    expect(parseRoute("#/health")).toEqual({ page: "health" });
    expect(commandIn("Run `gh auth login` first")).toBe("gh auth login");
    expect(commandIn("nothing")).toBeNull();
  });
});

describe("Faults panel", () => {
  const render = (faults: Parameters<typeof FaultsPanel>[0]["faults"]) => html(createElement(FaultsPanel, { faults, now: 10 * 3_600_000 }));
  it("says so when nothing survived, and lists classes with counts, ages and the error as text", () => {
    expect(render([])).toContain("No errors survived in the last 24h.");
    const out = render([{ repo: "a/b", category: "github_api", firstSeen: 2 * 3_600_000, lastSeen: 9 * 3_600_000, count: 7, recent24h: 4, lastError: "<script>alert(1)</script>" }]);
    expect(out).not.toContain("<script>alert");
    expect(out).toContain("&lt;script&gt;");
    for (const t of ["a/b", "github_api", "8h ago", "1h ago"]) expect(out).toContain(t);
    expect(out).not.toContain("No errors survived");
  });
  it("a null faults section (schema behind) shows its own message, not the empty copy", () => {
    const out = render(null);
    expect(out).toContain("Faults are unavailable");
    expect(out).not.toContain("No errors survived");
  });
  it("the state guard rejects a payload without faults", async () => {
    const { isUiState } = await import("../ui/src/payload.js");
    const { buildUiState } = await import("../src/core/ui-state.js");
    const s = buildUiState(new Ledger(":memory:"), 1000);
    expect(isUiState(s)).toBe(true);
    expect(isUiState({ ...s, faults: undefined })).toBe(false);
  });
});
