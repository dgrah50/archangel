import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENV_FEATURES, buildHostStatus, recordDaemonFacts } from "../src/core/host-facts.js";
import { startUiServer } from "../src/core/ui-server.js";
import { buildUiState } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";
import { Shell } from "../ui/src/Shell.js";
import { isHostStatus } from "../ui/src/payload.js";

const NOW = 10 * 86_400_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "arc-host-"));

describe("daemon-reported host facts", () => {
  it("records the hash of the loaded file and env presence as booleans, never values", () => {
    const dir = tmp();
    const cfg = path.join(dir, "archangel.yaml");
    fs.writeFileSync(cfg, "a: 1\n");
    const l = new Ledger(":memory:");
    recordDaemonFacts(l, { configPath: cfg, env: { ANTHROPIC_API_KEY: "sk-super-secret", PASEO_HOST: "" }, now: NOW });
    const s = buildHostStatus(l, cfg, NOW);
    expect(isHostStatus(s)).toBe(true);
    expect(s).toMatchObject({ reported: true, loadedAt: NOW, disk: "ok", restartPending: false });
    expect(s.envPresence!.ANTHROPIC_API_KEY).toBe(true);
    expect(s.envPresence!.PASEO_HOST).toBe(false);
    expect(Object.keys(s.envPresence!).sort()).toEqual(ENV_FEATURES.map((e) => e.name).sort());
    expect(JSON.stringify(s)).not.toContain("sk-super-secret");
  });

  it("flags restart pending when the file changes, clears when reverted, and handles missing files and unreported daemons", () => {
    const dir = tmp();
    const cfg = path.join(dir, "archangel.yaml");
    fs.writeFileSync(cfg, "a: 1\n");
    const l = new Ledger(":memory:");
    expect(buildHostStatus(l, cfg, NOW)).toMatchObject({ reported: false, restartPending: false });
    recordDaemonFacts(l, { configPath: cfg, env: {}, now: NOW });
    fs.writeFileSync(cfg, "a: 2\n");
    expect(buildHostStatus(l, cfg, NOW).restartPending).toBe(true);
    fs.writeFileSync(cfg, "a: 1\n");
    expect(buildHostStatus(l, cfg, NOW).restartPending).toBe(false);
    fs.rmSync(cfg);
    expect(buildHostStatus(l, cfg, NOW)).toMatchObject({ disk: "missing", restartPending: false });
  });

  it("a corrupt env_presence record reads as unknown, not as all unset", () => {
    const l = new Ledger(":memory:");
    l.setSystemState("env_presence", "{not json", NOW);
    expect(buildHostStatus(l, path.join(tmp(), "none.yaml"), NOW).envPresence).toBeNull();
    l.setSystemState("env_presence", JSON.stringify({ A: "yes" }), NOW);
    expect(buildHostStatus(l, path.join(tmp(), "none.yaml"), NOW).envPresence).toBeNull();
  });

  it("GET /api/host serves the status and refuses writes", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head></html>");
    const cfg = path.join(dir, "archangel.yaml");
    fs.writeFileSync(cfg, "a: 1\n");
    const l = new Ledger(":memory:");
    recordDaemonFacts(l, { configPath: cfg, env: {}, now: NOW });
    const server = await startUiServer(l, { host: "127.0.0.1", port: 0, uiDir: dir, configPath: cfg });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await (await fetch(`${base}/api/host`)).json()).toMatchObject({ reported: true, restartPending: false });
      expect((await fetch(`${base}/api/host`, { method: "POST" })).status).toBe(405);
    } finally {
      server.close();
    }
  });
});

describe("restart-pending chip", () => {
  const state = buildUiState(new Ledger(":memory:"), NOW);
  const render = (host: { data: unknown; at: number | null; error: string | null }) =>
    renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: createElement(Shell, { route: { page: "overview" }, state, host: host as never, children: null }) }));
  const base = { generatedAt: NOW, reported: true, loadedAt: NOW, loadedSha256: "a", diskSha256: "a", disk: "ok", restartPending: false, envPresence: {} };
  it("shows only when restart is pending; an unavailable feed says so", () => {
    expect(render({ data: base, at: NOW, error: null })).not.toContain("restart pending");
    expect(render({ data: { ...base, restartPending: true }, at: NOW, error: null })).toContain("Host config changed: restart pending");
    expect(render({ data: null, at: null, error: "boom" })).toContain("host status unavailable");
  });
});
