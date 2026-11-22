import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { PREVIEW_TTL_MS, makeHostConfigHandler, sha256, type ApplyResult, type PreviewResult } from "../src/core/ui-host-config.js";
import { startUiServer } from "../src/core/ui-server.js";
import { ProposeRefusal } from "../src/core/ui-propose.js";
import { Ledger } from "../src/ledger/store.js";

const YAML = "ownerUserId: 42\nprojects:\n  - repo: a/b\n";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "arc-w2-"));

function setup(text: string | null = YAML) {
  const dir = tmp();
  const configPath = path.join(dir, "archangel.yaml");
  if (text !== null) fs.writeFileSync(configPath, text);
  const audits: Array<{ topic: string; payload: Record<string, unknown>; fileAtAudit: string | null }> = [];
  let clock = 1_000_000;
  const handler = makeHostConfigHandler({
    configPath,
    env: {},
    now: () => clock,
    audit: (topic, payload) => audits.push({ topic, payload, fileAtAudit: fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null }),
  });
  return { dir, configPath, handler, audits, tick: (ms: number) => (clock += ms) };
}
const body = (o: object) => ({ mode: "preview", baseSha256: sha256(YAML), rawText: YAML, ...o });
const status = (fn: () => unknown): number => {
  try {
    fn();
    return 200;
  } catch (e) {
    if (e instanceof ProposeRefusal) return e.status;
    throw e;
  }
};

describe("W2 handler", () => {
  const edited = `${YAML}digestHour: 7\n`;
  it("apply writes exactly the previewed bytes: atomic, 0600, backed up, audited as host_config before the write", () => {
    const s = setup();
    s.handler(body({ rawText: edited }));
    const r = s.handler(body({ mode: "apply", rawText: edited, previewSha256: sha256(edited) })) as ApplyResult;
    expect(fs.readFileSync(s.configPath, "utf8")).toBe(edited);
    expect(fs.statSync(s.configPath).mode & 0o777).toBe(0o600);
    expect(r.backup && fs.readFileSync(r.backup, "utf8")).toBe(YAML);
    expect(fs.readdirSync(s.dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]!.topic).toBe("host_config/apply");
    expect(s.audits[0]!.fileAtAudit).toBe(YAML); // audited before the file changed
    expect(r.restartRequired).toBe(true);
  });
  it("apply refuses: a text that was not previewed, a different hash, an expired preview, and a replay", () => {
    const s = setup();
    expect(status(() => s.handler(body({ mode: "apply", rawText: edited, previewSha256: sha256(edited) })))).toBe(409);
    s.handler(body({ rawText: edited }));
    expect(status(() => s.handler(body({ mode: "apply", rawText: `${edited}x: 1\n`, previewSha256: sha256(edited) })))).toBe(400);
    s.tick(PREVIEW_TTL_MS + 1);
    expect(status(() => s.handler(body({ mode: "apply", rawText: edited, previewSha256: sha256(edited) })))).toBe(409);
    s.handler(body({ rawText: edited }));
    s.handler(body({ mode: "apply", rawText: edited, previewSha256: sha256(edited) }));
    expect(status(() => s.handler(body({ mode: "apply", baseSha256: sha256(edited), rawText: edited, previewSha256: sha256(edited) })))).toBe(409);
  });
  it("loosening is reported by preview and refused by apply without confirmLoosen", () => {
    const s = setup();
    const loose = `${YAML}maxDailyUsd: 99\n`;
    expect((s.handler(body({ rawText: loose })) as PreviewResult).loosening).toEqual(["maxDailyUsd 20 -> 99"]);
    expect(status(() => s.handler(body({ mode: "apply", rawText: loose, previewSha256: sha256(loose) })))).toBe(409);
    expect(status(() => s.handler(body({ mode: "apply", rawText: loose, previewSha256: sha256(loose), confirmLoosen: false })))).toBe(409);
    expect(fs.readFileSync(s.configPath, "utf8")).toBe(YAML);
    s.handler(body({ mode: "apply", rawText: loose, previewSha256: sha256(loose), confirmLoosen: true }));
    expect(fs.readFileSync(s.configPath, "utf8")).toBe(loose);
    expect(s.audits[0]!.payload.loosening).toEqual(["maxDailyUsd 20 -> 99"]);
  });
});

describe("server guards for the write routes", () => {
  async function boot(opts: { allowRemote?: boolean } = {}) {
    const ui = tmp();
    fs.writeFileSync(path.join(ui, "index.html"), "<html><head></head></html>");
    const dir = tmp();
    const configPath = path.join(dir, "archangel.yaml");
    fs.writeFileSync(configPath, YAML);
    const server = await startUiServer(new Ledger(":memory:"), {
      host: "127.0.0.1",
      port: 0,
      uiDir: ui,
      allowRemote: opts.allowRemote,
      proposeRunner: (async () => ({ stdout: "", stderr: "", code: 0 })) as never,
      hostConfig: { configPath, audit: () => {} },
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const page = await (await fetch(base)).text();
    return { server, base, port, configPath, token: /name="archangel-token" content="([0-9a-f]+)"/.exec(page)?.[1] ?? null };
  }
  const post = (base: string, headers: Record<string, string>, payload: unknown, p = "/api/host-config") =>
    fetch(`${base}${p}`, { method: "POST", headers, body: typeof payload === "string" ? payload : JSON.stringify(payload) });

  it("needs the token, a loopback Origin, JSON and a bounded body; GET of the raw file needs the token too", async () => {
    const { server, base, port, token, configPath } = await boot();
    try {
      const good = { "content-type": "application/json", "x-archangel-token": token!, origin: `http://127.0.0.1:${port}` };
      const payload = { mode: "preview", baseSha256: sha256(YAML), rawText: `${YAML}digestHour: 7\n` };
      expect((await post(base, { "content-type": "application/json", origin: good.origin }, payload)).status).toBe(401);
      expect((await post(base, { ...good, "x-archangel-token": "0".repeat(48) }, payload)).status).toBe(401);
      expect((await post(base, { ...good, origin: "http://evil.example" }, payload)).status).toBe(403);
      expect((await post(base, { ...good, origin: "" }, payload)).status).toBe(403);
      expect((await post(base, { ...good, "content-type": "text/plain" }, payload)).status).toBe(415);
      expect((await post(base, good, "not json")).status).toBe(400);
      expect((await post(base, good, "x".repeat(1_100_000))).status).toBe(413);
      const ok = await post(base, good, payload);
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as PreviewResult).valid).toBe(true);
      expect((await post(base, good, { ...payload, baseSha256: sha256("stale") })).status).toBe(409);
      expect(fs.readFileSync(configPath, "utf8")).toBe(YAML);
      expect((await fetch(`${base}/api/host-config`)).status).toBe(401);
      const read = await fetch(`${base}/api/host-config`, { headers: { "x-archangel-token": token! } });
      expect(await read.json()).toMatchObject({ state: "ok", text: YAML, sha256: sha256(YAML) });
      for (const method of ["PUT", "DELETE", "PATCH"]) expect((await fetch(`${base}/api/host-config`, { method })).status).toBe(405);
    } finally {
      server.close();
    }
  });

  it("remote mode refuses every write and the raw read, and embeds no token", async () => {
    const { server, base, token, configPath } = await boot({ allowRemote: true });
    try {
      expect(token).toBeNull();
      const headers = { "content-type": "application/json", "x-archangel-token": "0".repeat(48) };
      const payload = { mode: "apply", baseSha256: sha256(YAML), rawText: YAML, previewSha256: sha256(YAML) };
      expect((await post(base, headers, payload)).status).toBe(403);
      expect((await post(base, headers, {}, "/api/workflows/a%2Fb/propose")).status).toBe(403);
      expect((await fetch(`${base}/api/host-config`)).status).toBe(403);
      for (const method of ["PUT", "DELETE", "PATCH"]) expect((await fetch(`${base}/api/state`, { method })).status).toBe(405);
      expect(fs.readFileSync(configPath, "utf8")).toBe(YAML);
    } finally {
      server.close();
    }
  });

});

describe("invariants pinned by grep", () => {
  const read = (f: string) => fs.readFileSync(f, "utf8");
  it("the dashboard server never imports a GitHub client or shells out to merge, approve, comment, label or close", () => {
    for (const f of ["src/core/ui-server.ts", "src/core/ui-host-config.ts", "src/core/ui-state.ts", "src/core/ui-thread.ts", "src/core/ui-settings.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/github\/client/);
      expect(src, f).not.toMatch(/pr merge|pr review|pr comment|issue comment|issue close|\.mergePullRequest|\.addLabel|\.closeIssue/);
    }
  });
});
