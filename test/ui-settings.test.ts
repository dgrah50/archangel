import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { recordDaemonFacts } from "../src/core/host-facts.js";
import { startUiServer } from "../src/core/ui-server.js";
import { buildSettingsState } from "../src/core/ui-settings.js";
import { Ledger } from "../src/ledger/store.js";
import { APPLY, SettingsPage } from "../ui/src/SettingsPage.js";
import { isSettingsState } from "../ui/src/payload.js";
import { parseRoute } from "../ui/src/route.js";

const NOW = 10 * 86_400_000;
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: el }));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "arc-set-"));
const YAML = "ownerUserId: 42\nprojects:\n  - repo: a/b\n";
const write = (text: string) => {
  const f = path.join(tmp(), "archangel.yaml");
  fs.writeFileSync(f, text);
  return f;
};
const feed = (data: ReturnType<typeof buildSettingsState> | null, error: string | null = null) => ({ data, at: data ? NOW : null, error });
const page = (scope: "machine" | "repo" | "kernel", f: ReturnType<typeof feed>) => html(createElement(SettingsPage, { scope, settings: f, onRetry: () => {}, children: createElement("p", null, "PIPELINE-EMBED") }));

describe("buildSettingsState", () => {
  it("returns the validated config with defaults, the kernel, and env presence only from the daemon's recorded booleans", () => {
    const cfg = write(YAML);
    const l = new Ledger(":memory:");
    const unreported = buildSettingsState(l, cfg, NOW);
    expect(isSettingsState(unreported)).toBe(true);
    expect(unreported.host).toMatchObject({ state: "ok", config: { ownerUserId: 42, authMode: "subscription" } });
    expect(unreported.env.every((e) => e.set === null)).toBe(true);
    recordDaemonFacts(l, { configPath: cfg, env: { ANTHROPIC_API_KEY: "sk-secret-value-123" }, now: NOW });
    const s = buildSettingsState(l, cfg, NOW);
    expect(s.env.find((e) => e.name === "ANTHROPIC_API_KEY")!.set).toBe(true);
    expect(s.env.find((e) => e.name === "OPENAI_API_KEY")!.set).toBe(false);
    expect(JSON.stringify(s)).not.toContain("sk-secret-value-123");
    expect(s.kernel.reviewQuorum).toBe(2);
    expect(s.kernel.universalProtected).toContain(".github/");
  });
  it("reports missing, invalid and unreadable files without throwing", () => {
    const l = new Ledger(":memory:");
    expect(buildSettingsState(l, path.join(tmp(), "none.yaml"), NOW).host.state).toBe("missing");
    const bad = buildSettingsState(l, write("ownerUserId: nope\nprojects: []\n"), NOW);
    expect(bad.host).toMatchObject({ state: "invalid" });
    expect((bad.host as { error: string }).error).toContain("ownerUserId");
    expect(buildSettingsState(l, write("a: [unclosed"), NOW).host.state).toBe("unreadable");
  });
  it("an unknown key in the file is invalid (strict schema) and never echoed as a value", () => {
    const s = buildSettingsState(new Ledger(":memory:"), write(`${YAML}telegramBotToken: 123456789:SECRETSECRET\n`), NOW);
    expect(s.host.state).toBe("invalid");
    expect(JSON.stringify(s)).not.toContain("SECRETSECRET");
  });
});

describe("GET /api/settings", () => {
  it("serves state and refuses writes", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head></html>");
    const server = await startUiServer(new Ledger(":memory:"), { host: "127.0.0.1", port: 0, uiDir: dir, configPath: write(YAML) });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(isSettingsState(await (await fetch(`${base}/api/settings`)).json())).toBe(true);
      expect((await fetch(`${base}/api/settings`, { method: "PUT" })).status).toBe(405);
    } finally {
      server.close();
    }
  });
});

describe("SettingsPage", () => {
  const ok = buildSettingsState(new Ledger(":memory:"), write(YAML), NOW);
  it("machine scope labels every section as applying after restart and shows env as unknown when unreported", () => {
    const out = page("machine", feed(ok));
    for (const t of ["General", "Models and accounts", "Limits", "Projects", "Environment"]) expect(out).toContain(t);
    expect(out).toContain(APPLY.restart);
    expect(out).toContain("unknown");
    expect(out).toContain("a/b");
    expect(out).not.toContain("<input");
  });
  it("kernel scope is read-only labelled; repo scope embeds the pipeline", () => {
    const k = page("kernel", feed(ok));
    expect(k).toContain(APPLY.kernel);
    expect(k).toContain("2 independent vendors");
    expect(page("repo", feed(null))).toContain("PIPELINE-EMBED");
  });
  it("loading, error with Retry, stale-refresh, and a missing or invalid file are distinct", () => {
    expect(page("machine", feed(null))).toContain("Loading settings...");
    const err = page("machine", feed(null, "/api/settings: boom"));
    expect(err).toContain("Settings unavailable.");
    expect(err).toContain("Retry");
    expect(page("machine", feed(ok, "x"))).toContain("showing the last loaded copy");
    const missing = { ...ok, host: { state: "missing" as const, error: "No archangel.yaml at /x" } };
    expect(page("machine", feed(missing))).toContain("No archangel.yaml.");
    expect(page("machine", feed({ ...ok, host: { state: "invalid", error: "ownerUserId: bad" } }))).toContain("archangel.yaml is invalid.");
    expect(page("machine", feed({ ...ok, status: { ...ok.status, restartPending: true } }))).toContain("restart it to apply");
  });
  it("routes", () => {
    expect(parseRoute("#/settings")).toEqual({ page: "settings", scope: "machine" });
    expect(parseRoute("#/settings/repo")).toEqual({ page: "settings", scope: "repo" });
    expect(parseRoute("#/settings/kernel")).toEqual({ page: "settings", scope: "kernel" });
  });
});
