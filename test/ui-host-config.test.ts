import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BACKUPS_KEEP, PREVIEW_TTL_MS, classifyLoosening, lineDiff, makeHostConfigHandler, sha256, type ApplyResult, type PreviewResult } from "../src/core/ui-host-config.js";
import { startUiServer } from "../src/core/ui-server.js";
import { ProposeRefusal } from "../src/core/ui-propose.js";
import { HostYamlSchema } from "../src/config.js";
import { Ledger } from "../src/ledger/store.js";
import { parse } from "yaml";

const YAML = "ownerUserId: 42\nprojects:\n  - repo: a/b\n";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "arc-w2-"));
const host = (text: string) => HostYamlSchema.parse(parse(text));

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

describe("classifyLoosening", () => {
  const prev = host("ownerUserId: 1\nmaxDailyUsd: 20\nprojects:\n  - repo: a/b\n    maxAutoMergesPerDay: 3\n");
  const next = (extra: string) => host(`ownerUserId: 1\n${extra}`);
  it("flags raised limits, shadowMode off and Scouts on, and nothing for tightening or unrelated edits", () => {
    expect(classifyLoosening(prev, next("maxDailyUsd: 30\nprojects:\n  - repo: a/b\n    maxAutoMergesPerDay: 3\n"))[0]).toContain("maxDailyUsd 20 -> 30");
    expect(classifyLoosening(prev, next("projects:\n  - repo: a/b\n    maxAutoMergesPerDay: 5\n"))).toEqual(["a/b: maxAutoMergesPerDay 3 -> 5"]);
    expect(classifyLoosening(prev, next("projects:\n  - repo: a/b\n    shadowMode: false\n    maxAutoMergesPerDay: 3\n"))).toEqual(["a/b: shadowMode on -> off"]);
    expect(classifyLoosening(prev, next("projects:\n  - repo: a/b\n    maxAutoMergesPerDay: 3\n    scouts: { enabled: true, maxAutoPromotionsPerDay: 2 }\n"))).toEqual(["a/b: maxAutoPromotionsPerDay 1 -> 2", "a/b: scouts.enabled false -> true"]);
    expect(classifyLoosening(prev, next("maxDailyUsd: 5\nprojects:\n  - repo: a/b\n    maxAutoMergesPerDay: 1\n"))).toEqual([]);
    expect(classifyLoosening(prev, next("dailyTimezone: UTC\ndigestHour: 7\nprojects:\n  - repo: a/b\n    maxAutoMergesPerDay: 3\n"))).toEqual([]);
  });
  it("compares effective step limits: removing a project override that was stricter than the host loosens", () => {
    const strict = host("ownerUserId: 1\nmaxAutonomousStepsWithoutOwner: 25\nprojects:\n  - repo: a/b\n    maxAutonomousStepsWithoutOwner: 5\n");
    expect(classifyLoosening(strict, host("ownerUserId: 1\nmaxAutonomousStepsWithoutOwner: 25\nprojects:\n  - repo: a/b\n"))).toEqual(["a/b: maxAutonomousStepsWithoutOwner 5 -> 25"]);
    expect(classifyLoosening(strict, host("ownerUserId: 1\nmaxAutonomousStepsWithoutOwner: 25\nprojects:\n  - repo: a/b\n    maxAutonomousStepsWithoutOwner: 3\n"))).toEqual([]);
  });
  it("a new project is judged against the strictest stance, and a missing previous file against defaults", () => {
    expect(classifyLoosening(prev, host("ownerUserId: 1\nprojects:\n  - repo: a/b\n    maxAutoMergesPerDay: 3\n  - repo: c/d\n    shadowMode: false\n"))).toEqual(["c/d: shadowMode on -> off"]);
    expect(classifyLoosening(null, host(YAML))).toEqual([]);
    expect(classifyLoosening(null, host("ownerUserId: 1\nprojects:\n  - repo: a/b\n    scouts: { enabled: true }\n"))).toEqual(["a/b: scouts.enabled false -> true"]);
  });
});

describe("W2 handler", () => {
  const edited = `${YAML}digestHour: 7\n`;
  it("preview is read-only: reports the diff and returns the hash apply must quote", () => {
    const s = setup();
    const r = s.handler(body({ rawText: edited })) as PreviewResult;
    expect(r).toMatchObject({ mode: "preview", valid: true, loosening: [], previewSha256: sha256(edited) });
    expect(r.diff).toContain("+ digestHour: 7");
    expect(fs.readFileSync(s.configPath, "utf8")).toBe(YAML);
    expect(s.audits).toEqual([]);
  });
  it("an invalid file is reported with paths, never gets a previewSha256, and cannot be applied", () => {
    const s = setup();
    const r = s.handler(body({ rawText: "ownerUserId: nope\nprojects: []\n" })) as PreviewResult;
    expect(r.valid).toBe(false);
    expect(r.previewSha256).toBeUndefined();
    expect(r.errors.join(" ")).toContain("ownerUserId");
    expect(status(() => s.handler(body({ mode: "apply", rawText: "ownerUserId: nope\nprojects: []\n", previewSha256: sha256("ownerUserId: nope\nprojects: []\n") })))).toBe(409);
    expect((s.handler(body({ rawText: "a: [x" })) as PreviewResult).errors[0]).toContain("YAML");
  });
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
  it("a stale base is a 409 for both preview and apply, and a change between preview and apply is refused", () => {
    const s = setup();
    expect(status(() => s.handler(body({ baseSha256: sha256("other"), rawText: edited })))).toBe(409);
    s.handler(body({ rawText: edited }));
    fs.writeFileSync(s.configPath, `${YAML}digestHour: 3\n`);
    expect(status(() => s.handler(body({ mode: "apply", rawText: edited, previewSha256: sha256(edited) })))).toBe(409);
    expect(fs.readFileSync(s.configPath, "utf8")).toBe(`${YAML}digestHour: 3\n`);
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
  it("an audit failure means no write", () => {
    const dir = tmp();
    const configPath = path.join(dir, "archangel.yaml");
    fs.writeFileSync(configPath, YAML);
    const h = makeHostConfigHandler({ configPath, env: {}, audit: () => { throw new Error("ledger locked"); } });
    h(body({ rawText: edited }));
    expect(() => h(body({ mode: "apply", rawText: edited, previewSha256: sha256(edited) }))).toThrow("ledger locked");
    expect(fs.readFileSync(configPath, "utf8")).toBe(YAML);
    expect(fs.readdirSync(dir)).toEqual(["archangel.yaml"]);
  });
  it("creates the file when there is none (base null), with no backup", () => {
    const s = setup(null);
    const b = { mode: "preview", baseSha256: null, rawText: YAML };
    s.handler(b);
    const r = s.handler({ ...b, mode: "apply", previewSha256: sha256(YAML) }) as ApplyResult;
    expect(fs.readFileSync(s.configPath, "utf8")).toBe(YAML);
    expect(r.backup).toBeNull();
  });
  it("keeps only the newest backups", () => {
    const s = setup();
    let text = YAML;
    for (let i = 0; i < BACKUPS_KEEP + 3; i++) {
      const next = `${YAML}digestHour: ${i % 20}\nsetupTimeoutMs: ${10_000 + i}\n`;
      s.handler({ mode: "preview", baseSha256: sha256(text), rawText: next });
      s.handler({ mode: "apply", baseSha256: sha256(text), rawText: next, previewSha256: sha256(next) });
      text = next;
      s.tick(10);
    }
    expect(fs.readdirSync(s.dir).filter((f) => f.includes(".bak-"))).toHaveLength(BACKUPS_KEEP);
  });
  it("the path is never taken from the request: unknown keys are rejected", () => {
    const s = setup();
    expect(status(() => s.handler(body({ path: "/etc/passwd" })))).toBe(400);
    expect(status(() => s.handler({ mode: "nope" }))).toBe(400);
    expect(status(() => s.handler(body({ rawText: "x".repeat(300_000) })))).toBe(400);
  });
  it("lineDiff shows additions, removals and nothing for identical text", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toBe("- b\n+ d");
    expect(lineDiff("a", "a")).toBe("");
  });
});

describe("W2 never counts as the owner", () => {
  it("autonomousStepsSinceOwner is unchanged by an apply, and the audit actor is host_config", () => {
    const dir = tmp();
    const configPath = path.join(dir, "archangel.yaml");
    fs.writeFileSync(configPath, YAML);
    const dbPath = path.join(dir, "ledger.db");
    const l = new Ledger(dbPath, { repo: "a/b" });
    l.appendAudit("attempt/started", 1, "archangel", { kind: "implement" }, 1000, "a/b");
    l.appendAudit("attempt/started", 2, "archangel", { kind: "implement" }, 1001, "a/b");
    expect(l.autonomousStepsSinceOwner()).toBe(2);
    const h = makeHostConfigHandler({
      configPath,
      env: {},
      audit: (topic, payload, now) => {
        const w = new Ledger(dbPath);
        try {
          w.appendAudit(topic, null, "host_config", payload, now, null);
        } finally {
          w.close();
        }
      },
    });
    const edited = `${YAML}digestHour: 7\n`;
    h(body({ rawText: edited }));
    h(body({ mode: "apply", rawText: edited, previewSha256: sha256(edited) }));
    expect(l.autonomousStepsSinceOwner()).toBe(2);
    const row = l.listAudit({ topicPrefix: "host_config/" })[0]!;
    expect(row.actor).toBe("host_config");
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

  it("is 403 without a wired host config even locally", async () => {
    const ui = tmp();
    fs.writeFileSync(path.join(ui, "index.html"), "<html><head></head></html>");
    const server = await startUiServer(new Ledger(":memory:"), { host: "127.0.0.1", port: 0, uiDir: ui });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await post(base, { "content-type": "application/json" }, {})).status).toBe(403);
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
  it("the browser POSTs from two modules only (workflow-draft: the propose route; host-config-client: W2)", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const posts = walk("ui/src").filter((f) => /\.tsx?$/.test(f) && /method:\s*"(POST|PUT|PATCH|DELETE)"/.test(read(f)));
    expect(posts.map((f) => path.basename(f)).sort()).toEqual(["host-config-client.ts", "workflow-draft.ts"]);
  });
});
