import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "bun:test";
import type { OnboardRunner } from "../src/core/onboard.js";
import { draftFromEffective } from "../src/core/ui-propose.js";
import { startUiServer } from "../src/core/ui-server.js";
import { resolveWorkflow } from "../src/core/workflow.js";
import { Ledger } from "../src/ledger/store.js";
import { hostInput, workflowFile } from "./helpers/workflow.js";

const FILE = workflowFile([{ name: "bug-hunt", promotion: "auto" }], { landing: { bugfix: "autonomous" } });
const RAW = JSON.stringify(FILE);

function resolved() {
  const r = resolveWorkflow(hostInput(), { repo: "a/b", mainSha: "m".repeat(40), fileRaw: RAW, scoutPrompts: { "bug-hunt": "SECRET-PROMPT" } });
  if (r.status !== "ok") throw new Error("not ok");
  return r;
}
function ledger() {
  const l = new Ledger(":memory:", { repo: "a/b" });
  l.setSystemState("workflow:a/b", JSON.stringify(resolved()));
  return l;
}
const draft = () => draftFromEffective(resolved());
const edit = (f: (d: any) => void) => {
  const d = structuredClone(draft()) as any;
  f(d);
  return d;
};

describe("POST /api/workflows/:repo/propose", () => {
  function runnerFake(currentRaw = RAW) {
    const calls: string[] = [];
    const runner: OnboardRunner = {
      async run(_c, args) {
        const line = args.join(" ");
        calls.push(line);
        if (line.startsWith("repo view")) return "main\n";
        if (line.includes("contents/.agents/archangel.json?ref=")) return args.includes("--jq") ? "blob\n" : currentRaw;
        if (/contents\/\.agents\/scouts\/bug-hunt\.md\?ref=/.test(line)) return args.includes("--jq") ? "sb\n" : "SECRET-PROMPT\n";
        if (line.startsWith("pr list")) return "";
        if (/git\/ref\/heads\/chore\//.test(line)) throw new Error("HTTP 404");
        if (line.includes("/git/ref/heads/")) return "tip\n";
        if (line.startsWith("pr create")) return "https://github.com/a/b/pull/7\n";
        return "";
      },
    };
    return { runner, calls };
  }
  async function start(opts: { allowRemote?: boolean; withRunner?: boolean; runner?: OnboardRunner } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-ui-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head><body><div id=root></div></body></html>");
    const fake = runnerFake();
    const server = await startUiServer(ledger(), {
      host: "127.0.0.1",
      port: 0,
      uiDir: dir,
      allowRemote: opts.allowRemote,
      proposeRunner: opts.withRunner === false ? undefined : (opts.runner ?? fake.runner),
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const html = await fetch(base).then((r) => r.text());
    const token = /name="archangel-token" content="([0-9a-f]+)"/.exec(html)?.[1];
    const body = (over: object = {}) => JSON.stringify({ draft: draft(), baseFileSha256: resolved().fileSha256, dryRun: true, ...over });
    // node:http, because fetch refuses to send a caller-chosen Origin header.
    const post = (h: Record<string, string>, b = body()) =>
      new Promise<{ status: number; json: () => Promise<any> }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: `/api/workflows/${encodeURIComponent("a/b")}/propose`, method: "POST", headers: h },
          (res) => {
            let data = "";
            res.on("data", (c) => (data += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, json: async () => JSON.parse(data) }));
          },
        );
        req.on("error", reject);
        req.end(b);
      });
    const good = { "Content-Type": "application/json", "X-Archangel-Token": token ?? "", Origin: base };
    return { server, base, token, post, good, fake, body, html };
  }

  it("injects the token into the served page and rejects a missing token, wrong Origin, wrong Content-Type", async () => {
    const t = await start();
    try {
      expect(t.token).toMatch(/^[0-9a-f]{48}$/);
      const noToken = await t.post({ "Content-Type": "application/json", Origin: t.base });
      expect(noToken.status).toBe(401);
      expect((await t.post({ ...t.good, "X-Archangel-Token": "nope" })).status).toBe(401);
      expect((await t.post({ ...t.good, Origin: "http://evil.example" })).status).toBe(403);
      expect((await t.post({ "Content-Type": t.good["Content-Type"]!, "X-Archangel-Token": t.token! })).status).toBe(403); // no Origin
      expect((await t.post({ ...t.good, "Content-Type": "text/plain" })).status).toBe(415);
      expect(t.fake.calls).toEqual([]);
      // every other non-GET stays refused
      expect((await fetch(`${t.base}/api/state`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${t.base}/api/workflows/a%2Fb/propose`, { method: "PUT" })).status).toBe(405);
    } finally {
      t.server.close();
    }
  });

  it("is disabled under --allow-remote and without a runner, and no token is served", async () => {
    for (const o of [{ allowRemote: true }, { withRunner: false }]) {
      const t = await start(o);
      try {
        expect(t.token).toBeUndefined();
        const r = await t.post({ "Content-Type": "application/json", "X-Archangel-Token": "x", Origin: t.base });
        expect(r.status).toBe(403);
      } finally {
        t.server.close();
      }
    }
  });

  it("opens one PR through proposeWorkflow (never merging) and refuses when GitHub's file moved on", async () => {
    const t = await start();
    try {
      const res = await t.post(t.good, t.body({ dryRun: false, draft: edit((d) => { d.gate.maxFiles = 3; }) }));
      expect(res.status).toBe(200);
      expect((await res.json()).url).toBe("https://github.com/a/b/pull/7");
      expect(t.fake.calls.some((c) => c.startsWith("pr create"))).toBe(true);
      expect(t.fake.calls.some((c) => /pr merge/.test(c))).toBe(false);
      expect(t.fake.calls.find((c) => c.includes("-X PUT"))).toContain("sha=blob");
    } finally {
      t.server.close();
    }
    const moved = runnerFake(JSON.stringify({ ...FILE, requiredChecks: ["Gate", "Z"] }));
    const t2 = await start({ runner: moved.runner });
    try {
      const res = await t2.post(t2.good, t2.body({ dryRun: false, draft: edit((d) => { d.gate.maxFiles = 3; }) }));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/Stale draft/);
      expect(moved.calls.some((c) => /-X (POST|PUT)|pr create/.test(c))).toBe(false);
    } finally {
      t2.server.close();
    }
  });
});

