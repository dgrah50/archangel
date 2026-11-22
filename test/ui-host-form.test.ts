import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerToVendor } from "../src/config.js";
import { sha256 } from "../src/core/ui-host-config.js";
import { startUiServer } from "../src/core/ui-server.js";
import { Ledger } from "../src/ledger/store.js";
import { applyHostConfig, loadHostConfig, previewHostConfig } from "../ui/src/host-config-client.js";
import { addChainEntry, checkIndependence, editField, moveChainEntry, readForm, removeChainEntry, setChainEntry, VENDOR } from "../ui/src/host-edit.js";
import { HostErrorNotice, IndependenceNotice, PreviewPanel } from "../ui/src/HostConfigEditor.js";

const YAML = `# my host
ownerUserId: 42 # the owner
maxDailyUsd: 20
chains:
  implement:
    - provider: codex # first
    - provider: agy
reviewerChain:
  - provider: agy
  - provider: claude
  - provider: codex
projects:
  - repo: a/b
`;
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: el }));

describe("YAML Document edits", () => {
  it("changing a field keeps every comment and the rest of the file byte-identical", () => {
    const out = editField(YAML, ["maxDailyUsd"], 30);
    expect(out).toBe(YAML.replace("maxDailyUsd: 20", "maxDailyUsd: 30"));
    expect(out).toContain("# my host");
    expect(out).toContain("# the owner");
  });
  it("adds a missing key, and an unparsable file is refused rather than rewritten", () => {
    expect(editField(YAML, ["digestHour"], 7)).toContain("digestHour: 7");
    expect(() => editField("a: [\n", ["x"], 1)).toThrow();
  });
  it("chain entries: set provider, model, add, remove, move; comments on untouched entries survive", () => {
    let t = setChainEntry(YAML, ["chains", "implement"], 1, { provider: "claude", model: "m" });
    expect(readForm(t)!.chains.implement).toEqual([{ provider: "codex" }, { provider: "claude", model: "m" }]);
    expect(t).toContain("# first");
    t = addChainEntry(t, ["chains", "implement"], "agy");
    expect(readForm(t)!.chains.implement.map((e) => e.provider)).toEqual(["codex", "claude", "agy"]);
    t = moveChainEntry(t, ["chains", "implement"], 2, -1);
    expect(readForm(t)!.chains.implement.map((e) => e.provider)).toEqual(["codex", "agy", "claude"]);
    t = removeChainEntry(t, ["chains", "implement"], 0);
    expect(readForm(t)!.chains.implement.map((e) => e.provider)).toEqual(["agy", "claude"]);
  });
  it("readForm is null for text that does not parse as a mapping", () => {
    expect(readForm("a: [\n")).toBeNull();
    expect(readForm("- 1\n")).toBeNull();
  });
});

describe("live independence check", () => {
  const chains = (w: string[], r: string[]) => ({ chains: { implement: w.map((provider) => ({ provider })), revise: [], rebase: [] }, reviewerChain: r.map((provider) => ({ provider })), authMode: "subscription" });
  it("the vendor map matches the daemon's providerToVendor", () => {
    for (const p of ["codex", "agy", "claude"] as const) expect(VENDOR[p]).toBe(providerToVendor(p));
  });
  it("passes when, whichever vendor wrote, two other reviewer vendors remain", () => {
    expect(checkIndependence(chains(["codex"], ["agy", "claude", "codex"]) as never).problems).toEqual([]);
  });
  it("fails when the reviewers are the writers' only vendors", () => {
    const r = checkIndependence(chains(["codex", "agy"], ["codex", "agy"]) as never);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems.join(" ")).toContain("openai");
  });
  it("fails when removing the writer vendor leaves fewer than two reviewers", () => {
    expect(checkIndependence(chains(["claude"], ["claude", "agy"]) as never).problems).toHaveLength(1);
  });
});

describe("error states are rendered, never silent", () => {
  const e = (kind: string, message: string) => html(createElement(HostErrorNotice, { error: { kind, message } as never, onReload: () => {} }));
  it("conflict offers reload", () => {
    const out = e("conflict", "archangel.yaml changed on disk since you loaded it");
    expect(out).toContain('role="alert"');
    expect(out).toContain("changed on disk");
    expect(out).toContain("Reload");
  });
  it("validation, 403, 401, schema behind and network each say what happened", () => {
    expect(e("validation", "ownerUserId: required")).toContain("ownerUserId: required");
    expect(e("forbidden", "host config writes are disabled")).toContain("remote");
    expect(e("unauthorized", "missing or invalid token")).toContain("token");
    expect(e("schema_behind", "x")).toContain("Ledger schema is behind");
    expect(e("network", "network error: boom")).toContain("network error: boom");
  });
  it("an invalid preview lists its errors and offers no Apply; a loosening preview asks for confirmation", () => {
    const base = { mode: "preview" as const, warnings: [], diff: "+ x", baseSha256: null, loosening: [] as string[], errors: [] as string[] };
    const bad = html(createElement(PreviewPanel, { preview: { ...base, valid: false, errors: ["ownerUserId: Required"] }, confirm: false, onConfirm: () => {}, onApply: () => {}, busy: false, blocked: null }));
    expect(bad).toContain("ownerUserId: Required");
    expect(bad).not.toContain(">Apply<");
    const loose = html(createElement(PreviewPanel, { preview: { ...base, valid: true, previewSha256: "a".repeat(64), loosening: ["maxDailyUsd 20 -> 50"] }, confirm: false, onConfirm: () => {}, onApply: () => {}, busy: false, blocked: null }));
    expect(loose).toContain("maxDailyUsd 20 -&gt; 50");
    expect(loose).toContain("disabled");
  });
  it("independence failure is an alert", () => {
    expect(html(createElement(IndependenceNotice, { problems: ["x"] }))).toContain('role="alert"');
    expect(html(createElement(IndependenceNotice, { problems: [] }))).not.toContain('role="alert"');
  });
});

describe("the host-config client against the real route", () => {
  const stubs: Array<() => void> = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const s of stubs.splice(0)) s();
  });
  async function boot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-u8-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head></html>");
    const configPath = path.join(dir, "archangel.yaml");
    fs.writeFileSync(configPath, YAML);
    const server = await startUiServer(new Ledger(":memory:", { repo: "a/b" }), { host: "127.0.0.1", port: 0, uiDir: dir, configPath, hostConfig: { configPath, audit: () => {} } });
    stubs.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const token = /name="archangel-token" content="([0-9a-f]+)"/.exec(await (await fetch(base)).text())![1]!;
    vi.stubGlobal("document", { querySelector: () => ({ content: token }) });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (u: string, i?: RequestInit) => realFetch(`${base}${u}`, { ...i, headers: { ...(i?.headers as Record<string, string>), origin: base } }));
    return { configPath, base };
  }
  it("load, preview, apply: the edited text lands with its comments", async () => {
    const { configPath } = await boot();
    const loaded = await loadHostConfig();
    expect(loaded).toMatchObject({ ok: true, value: { state: "ok", sha256: sha256(YAML) } });
    const text = editField(YAML, ["maxDailyUsd"], 10);
    const p = await previewHostConfig(sha256(YAML), text);
    expect(p.ok && p.value.valid).toBe(true);
    if (!p.ok || !p.value.previewSha256) throw new Error("no preview");
    const a = await applyHostConfig(sha256(YAML), text, p.value.previewSha256, false);
    expect(a.ok).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(text);
  });
  it("stale base is a conflict; an invalid file is a valid=false preview with errors", async () => {
    await boot();
    const c = await previewHostConfig(sha256("other"), YAML);
    expect(c).toMatchObject({ ok: false, error: { kind: "conflict" } });
    const bad = await previewHostConfig(sha256(YAML), "ownerUserId: 1\n");
    expect(bad.ok && bad.value.valid).toBe(false);
  });
  it("apply without confirmLoosen is refused with its reason; unquoted preview hash is a validation error", async () => {
    await boot();
    const text = editField(YAML, ["maxDailyUsd"], 99);
    const p = await previewHostConfig(sha256(YAML), text);
    const hash = p.ok ? p.value.previewSha256! : "";
    const r = await applyHostConfig(sha256(YAML), text, hash, false);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error.message).toContain("confirmLoosen");
    const wrong = await applyHostConfig(sha256(YAML), text, "0".repeat(64), true);
    expect(wrong).toMatchObject({ ok: false, error: { kind: "validation" } });
  });
  it("403 (remote), 401, schema behind and network failure are classified", async () => {
    const reply = (status: number, body: unknown) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("document", { querySelector: () => null });
    reply(403, { error: "host config writes are disabled" });
    expect(await previewHostConfig(null, "x")).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    reply(401, { error: "missing or invalid token" });
    expect(await loadHostConfig()).toMatchObject({ ok: false, error: { kind: "unauthorized" } });
    reply(503, { error: "ledger_schema_behind", detail: "no such table" });
    expect(await loadHostConfig()).toMatchObject({ ok: false, error: { kind: "schema_behind" } });
    reply(500, { error: "SqliteError: no such column: x" });
    expect(await applyHostConfig(null, "x", "a".repeat(64), false)).toMatchObject({ ok: false, error: { kind: "schema_behind" } });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await loadHostConfig()).toMatchObject({ ok: false, error: { kind: "network" } });
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 502 }));
    expect(await loadHostConfig()).toMatchObject({ ok: false, error: { kind: "error" } });
  });
});
