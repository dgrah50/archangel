import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ONBOARD_BRANCH, type OnboardRunner } from "../src/core/onboard.js";
import { PLAN_TTL_MS, makeOnboardHandler, type ApplyResult, type PlanResult } from "../src/core/ui-onboard.js";
import { GH_CACHE_MS, makeGhReads } from "../src/core/ui-gh.js";
import { startUiServer } from "../src/core/ui-server.js";
import { ProposeRefusal } from "../src/core/ui-propose.js";
import { Ledger } from "../src/ledger/store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "arc-w3-"));
type Call = { cmd: string; args: string[] };

/** A fake gh/git: a clean Archangel checkout on origin/main and a small Go repo with no policy yet. */
function fakeRunner(opts: { failOn?: (c: Call) => boolean } = {}) {
  const calls: Call[] = [];
  const runner: OnboardRunner = {
    async run(cmd, args) {
      const c = { cmd, args };
      calls.push(c);
      if (opts.failOn?.(c)) throw new Error("HTTP 403: boom");
      const j = args.join(" ");
      if (cmd === "git") return j.startsWith("rev-parse") ? "abc123\n" : "";
      if (j.startsWith("repo view")) return "main\n";
      if (j.includes("git/trees")) return "go.mod\nmain.go\n";
      if (j.startsWith("label list")) return "";
      if (j.startsWith("pr list")) return "";
      if (j.includes("git/ref/heads/main")) return "basesha\n";
      if (j.includes(`git/ref/heads/${ONBOARD_BRANCH}`)) throw new Error("HTTP 404 Not Found");
      if (j.startsWith("pr create")) return "https://github.com/a/b/pull/7\n";
      return "";
    },
  };
  return { runner, calls };
}
const MUTATING = (c: Call) => c.cmd === "gh" && (c.args[0] === "label" && c.args[1] === "create" || c.args[0] === "pr" && c.args[1] === "create" || c.args.includes("-X"));

function setup() {
  const f = fakeRunner();
  const audits: Array<{ topic: string; writesSoFar: number }> = [];
  let clock = 1_000;
  const handler = makeOnboardHandler({
    runner: f.runner,
    now: () => clock,
    audit: (topic) => audits.push({ topic, writesSoFar: f.calls.filter(MUTATING).length }),
  });
  return { ...f, handler, audits, tick: (ms: number) => (clock += ms) };
}
const refusal = async (p: Promise<unknown>): Promise<number> => {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof ProposeRefusal) return e.status;
    throw e;
  }
};

describe("W3 handler", () => {
  it("plan is read-only and returns the hash apply must quote", async () => {
    const s = setup();
    const r = (await s.handler("a/b", { mode: "plan" })) as PlanResult;
    expect(r.plan.repo).toBe("a/b");
    expect(r.plan.files.map((f) => f.path)).toContain(".agents/archangel.json");
    expect(r.planSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(s.calls.filter(MUTATING)).toEqual([]);
    expect(s.audits).toEqual([]);
  });

  it("apply runs the existing applyPlan, audited BEFORE any write, and opens only the onboarding PR", async () => {
    const s = setup();
    const { planSha256 } = (await s.handler("a/b", { mode: "plan" })) as PlanResult;
    const r = (await s.handler("a/b", { mode: "apply", planSha256 })) as ApplyResult;
    expect(r.log.join("\n")).toContain("Opened https://github.com/a/b/pull/7");
    expect(s.audits).toEqual([{ topic: "onboard/apply", writesSoFar: 0 }]);
    expect(s.calls.filter(MUTATING).length).toBeGreaterThan(0);
  });

  it("INVARIANT: never merges, approves, comments or pushes to the default branch; every write targets the onboarding branch or a label", async () => {
    const s = setup();
    const { planSha256 } = (await s.handler("a/b", { mode: "plan" })) as PlanResult;
    await s.handler("a/b", { mode: "apply", planSha256 });
    for (const c of s.calls.filter((x) => x.cmd === "gh")) {
      const j = c.args.join(" ");
      expect(["merge", "review", "comment", "close"]).not.toContain(c.args[1]);
      expect(c.args).not.toContain("--approve");
      if (c.args.includes("-X")) {
        const write = c.args.join(" ");
        expect(write).not.toMatch(/heads\/main\b/);
        expect(write).toMatch(new RegExp(`git/refs|contents/|heads/${ONBOARD_BRANCH}`));
      }
      if (c.args[0] === "api" && c.args.includes("PUT")) expect(j).toContain(`branch=${ONBOARD_BRANCH}`);
      if (c.args[0] === "pr" && c.args[1] === "create") expect(j).toContain(`--head ${ONBOARD_BRANCH}`);
    }
    const puts = s.calls.filter((c) => c.args.includes("PUT"));
    expect(puts.length).toBeGreaterThan(0);
    for (const c of puts) expect(c.args).toContain(`branch=${ONBOARD_BRANCH}`);
  });

  it("apply refuses without a plan, with a wrong hash, for another repo, after the TTL, and on replay", async () => {
    const s = setup();
    expect(await refusal(s.handler("a/b", { mode: "apply", planSha256: "0".repeat(64) }))).toBe(409);
    expect(await refusal(s.handler("a/b", { mode: "apply" }))).toBe(409);
    const { planSha256 } = (await s.handler("a/b", { mode: "plan" })) as PlanResult;
    expect(await refusal(s.handler("a/b", { mode: "apply", planSha256: "1".repeat(64) }))).toBe(409);
    expect(await refusal(s.handler("c/d", { mode: "apply", planSha256 }))).toBe(409);
    s.tick(PLAN_TTL_MS + 1);
    expect(await refusal(s.handler("a/b", { mode: "apply", planSha256 }))).toBe(409);
    const fresh = (await s.handler("a/b", { mode: "plan" })) as PlanResult;
    await s.handler("a/b", { mode: "apply", planSha256: fresh.planSha256 });
    expect(await refusal(s.handler("a/b", { mode: "apply", planSha256: fresh.planSha256 }))).toBe(409);
    expect(s.calls.filter(MUTATING).length).toBeGreaterThan(0);
  });

  it("an audit failure means no write", async () => {
    const f = fakeRunner();
    const h = makeOnboardHandler({ runner: f.runner, audit: () => { throw new Error("disk full"); } });
    const { planSha256 } = (await h("a/b", { mode: "plan" })) as PlanResult;
    await expect(h("a/b", { mode: "apply", planSha256 })).rejects.toThrow("disk full");
    expect(f.calls.filter(MUTATING)).toEqual([]);
  });

  it("a failed gh call is a 502 with gh's message, never a silent success", async () => {
    const f = fakeRunner({ failOn: (c) => c.args[0] === "label" && c.args[1] === "create" });
    const h = makeOnboardHandler({ runner: f.runner, audit: () => {} });
    const { planSha256 } = (await h("a/b", { mode: "plan" })) as PlanResult;
    await expect(h("a/b", { mode: "apply", planSha256 })).rejects.toMatchObject({ status: 502, message: expect.stringContaining("boom") });
    const g = fakeRunner({ failOn: (c) => c.args[0] === "repo" });
    expect(await refusal(makeOnboardHandler({ runner: g.runner, audit: () => {} })("a/b", { mode: "plan" }))).toBe(502);
  });

  it("validates the slug and rejects unknown body keys", async () => {
    const s = setup();
    expect(await refusal(s.handler("not a slug", { mode: "plan" }))).toBe(400);
    expect(await refusal(s.handler("a/b", { mode: "plan", repo: "x/y" }))).toBe(400);
    expect(await refusal(s.handler("a/b", { mode: "nope" }))).toBe(400);
  });
});

describe("R-gh reads", () => {
  function reads(failing = false) {
    const calls: Call[] = [];
    let clock = 0;
    const runner: OnboardRunner = {
      async run(cmd, args) {
        calls.push({ cmd, args });
        if (failing) throw new Error("HTTP 404: Branch not protected");
        return args[0] === "repo" ? '[{"nameWithOwner":"a/b"}]' : args[0] === "pr" ? '{"state":"OPEN"}' : args[1] === "user" ? '{"id":42,"login":"me"}' : '{"required_status_checks":{}}';
      },
    };
    return { calls, read: makeGhReads({ runner, now: () => clock }), tick: (ms: number) => (clock += ms) };
  }
  const q = (s: string) => new URLSearchParams(s);

  it("returns repo list, user id, PR status and protection, with read-only argv", async () => {
    const r = reads();
    expect(await r.read("repos", q(""))).toEqual([{ nameWithOwner: "a/b" }]);
    expect(await r.read("user", q(""))).toEqual({ id: 42, login: "me" });
    expect(await r.read("pr", q("repo=a/b&number=3"))).toEqual({ state: "OPEN" });
    expect(await r.read("protection", q("repo=a/b&branch=main"))).toEqual({ required_status_checks: {} });
    for (const c of r.calls) {
      expect(c.cmd).toBe("gh");
      const j = c.args.join(" ");
      expect(j).not.toMatch(/(^| )(-X|--method|-f|-F|--field|--raw-field|--input)( |$)/);
      expect(j).not.toMatch(/\b(create|merge|review|comment|close|edit|delete)\b/);
      expect(["repo list", "api user", "pr view", "api repos/a/b/branches/main/protection"]).toContain(c.args.slice(0, 2).join(" "));
    }
  });

  it("a failed read is a 502 carrying gh's message and is not cached", async () => {
    const r = reads(true);
    await expect(r.read("protection", q("repo=a/b&branch=main"))).rejects.toMatchObject({ status: 502, message: expect.stringContaining("Branch not protected") });
    await expect(r.read("protection", q("repo=a/b&branch=main"))).rejects.toMatchObject({ status: 502 });
    expect(r.calls.length).toBe(2);
  });

  it("caches successes for 30 s", async () => {
    const r = reads();
    await r.read("user", q(""));
    await r.read("user", q(""));
    expect(r.calls.length).toBe(1);
    r.tick(GH_CACHE_MS + 1);
    await r.read("user", q(""));
    expect(r.calls.length).toBe(2);
  });

  it("validates request values before running anything", async () => {
    const r = reads();
    for (const [k, query] of [["pr", "repo=a/b&number=0"], ["pr", "repo=bad&number=1"], ["protection", "repo=a/b&branch=--evil"], ["protection", "repo=a/b&branch=a/../b"], ["protection", "repo=a/b"]] as const) {
      expect(await refusal(r.read(k, q(query)))).toBe(400);
    }
    expect(r.calls).toEqual([]);
  });
});

describe("server routes", () => {
  async function boot(opts: { allowRemote?: boolean; wired?: boolean } = {}) {
    const ui = tmp();
    fs.writeFileSync(path.join(ui, "index.html"), "<html><head></head></html>");
    const f = fakeRunner();
    const audits: string[] = [];
    const server = await startUiServer(new Ledger(":memory:"), {
      host: "127.0.0.1",
      port: 0,
      uiDir: ui,
      allowRemote: opts.allowRemote,
      proposeRunner: f.runner,
      onboardAudit: opts.wired === false ? undefined : (t) => void audits.push(t),
    });
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const page = await (await fetch(base)).text();
    return { server, base, port, calls: f.calls, audits, token: /name="archangel-token" content="([0-9a-f]+)"/.exec(page)?.[1] ?? null };
  }
  const post = (base: string, headers: Record<string, string>, payload: unknown, p = "/api/onboard/a%2Fb") =>
    fetch(`${base}${p}`, { method: "POST", headers, body: typeof payload === "string" ? payload : JSON.stringify(payload) });

  it("onboard needs the token, a loopback Origin, JSON, a bounded body and a valid slug; plan then apply works", async () => {
    const { server, base, port, token, calls, audits } = await boot();
    try {
      const good = { "content-type": "application/json", "x-archangel-token": token!, origin: `http://127.0.0.1:${port}` };
      const plan = { mode: "plan" };
      expect((await post(base, { "content-type": "application/json", origin: good.origin }, plan)).status).toBe(401);
      expect((await post(base, { ...good, "x-archangel-token": "0".repeat(48) }, plan)).status).toBe(401);
      expect((await post(base, { ...good, origin: "http://evil.example" }, plan)).status).toBe(403);
      expect((await post(base, { ...good, origin: "" }, plan)).status).toBe(403);
      expect((await post(base, { ...good, "content-type": "text/plain" }, plan)).status).toBe(415);
      expect((await post(base, good, "not json")).status).toBe(400);
      expect((await post(base, good, "x".repeat(1_100_000))).status).toBe(413);
      expect((await post(base, good, plan, "/api/onboard/not-a-slug")).status).toBe(400);
      expect(calls).toEqual([]);
      const ok = await post(base, good, plan);
      expect(ok.status).toBe(200);
      const { planSha256 } = (await ok.json()) as PlanResult;
      expect((await post(base, good, { mode: "apply", planSha256: "0".repeat(64) })).status).toBe(409);
      expect(audits).toEqual([]);
      const applied = await post(base, good, { mode: "apply", planSha256 });
      expect(applied.status).toBe(200);
      expect(audits).toEqual(["onboard/apply"]);
      expect((await fetch(`${base}/api/onboard/a%2Fb`, { method: "PUT" })).status).toBe(405);
    } finally {
      server.close();
    }
  });

  it("remote mode: onboard and every /api/gh route are 403 and no token is embedded; unwired onboard is 403 locally", async () => {
    const remote = await boot({ allowRemote: true });
    try {
      expect(remote.token).toBeNull();
      const headers = { "content-type": "application/json", "x-archangel-token": "0".repeat(48) };
      expect((await post(remote.base, headers, { mode: "plan" })).status).toBe(403);
      for (const p of ["repos", "user", "pr?repo=a/b&number=1", "protection?repo=a/b&branch=main"]) {
        expect((await fetch(`${remote.base}/api/gh/${p}`, { headers })).status).toBe(403);
      }
      expect(remote.calls).toEqual([]);
    } finally {
      remote.server.close();
    }
    const unwired = await boot({ wired: false });
    try {
      const headers = { "content-type": "application/json", "x-archangel-token": unwired.token!, origin: `http://127.0.0.1:${unwired.port}` };
      expect((await post(unwired.base, headers, { mode: "plan" })).status).toBe(403);
    } finally {
      unwired.server.close();
    }
  });

  it("GET /api/gh/* needs the token, is read-only, and a failed read is a 502 error body", async () => {
    const { server, base, token, calls } = await boot();
    try {
      expect((await fetch(`${base}/api/gh/user`)).status).toBe(401);
      const h = { "x-archangel-token": token! };
      expect((await fetch(`${base}/api/gh/pr?repo=a/b&number=x`, { headers: h })).status).toBe(400);
      expect(calls).toEqual([]);
      // The fake returns "" for this read, which is not JSON: a clear error, not a default.
      const r = await fetch(`${base}/api/gh/user`, { headers: h });
      expect(r.status).toBe(502);
      expect(((await r.json()) as { error: string }).error).toContain("non-JSON");
      for (const method of ["POST", "PUT", "DELETE"]) expect((await fetch(`${base}/api/gh/user`, { method, headers: h })).status).not.toBe(200);
      expect(calls.filter(MUTATING)).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe("invariants pinned by grep", () => {
  it("the new modules never import a GitHub client or shell out to merge, approve, comment or close", () => {
    for (const f of ["src/core/ui-onboard.ts", "src/core/ui-gh.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/github\/client/);
      expect(src, f).not.toMatch(/pr merge|pr review|pr comment|issue comment|issue close|\.mergePullRequest|\.addLabel|\.closeIssue|"merge"|"review"/);
    }
  });
});
