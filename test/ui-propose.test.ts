import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OnboardRunner } from "../src/core/onboard.js";
import { draftFromEffective, lineDiff, previewDraft } from "../src/core/ui-propose.js";
import { startUiServer } from "../src/core/ui-server.js";
import { buildWorkflowsState } from "../src/core/ui-state.js";
import { resolveWorkflow } from "../src/core/workflow.js";
import { Ledger } from "../src/ledger/store.js";
import { PreviewView, WorkflowEditor } from "../ui/src/WorkflowEditor.js";
import { fromForm, toForm } from "../ui/src/workflow-draft.js";
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

describe("draft and preview", () => {
  it("rebuilds the current file as an editable draft without Scout prompts, and round-trips through the form", () => {
    const d = draft();
    expect(d.version).toBe(1);
    expect(JSON.stringify(d)).not.toContain("SECRET-PROMPT");
    expect(d.landing.bugfix).toBe("autonomous");
    expect(fromForm(toForm(d), d)).toEqual(d);
    const form = toForm(d);
    form.maxFiles = 2;
    form.protectedPaths = "a/**\nb/**";
    form.scouts[0]!.promotion = "owner";
    const next = fromForm(form, d);
    expect(next.gate.maxFiles).toBe(2);
    expect(next.gate.protectedPaths).toEqual(["a/**", "b/**"]);
    expect(next.scouts[0]!.promotion).toBe("owner");
    expect(next.gate.testFileGlobs).toEqual(d.gate.testFileGlobs); // hidden fields untouched
  });

  it("classifies with loosened fields first and produces a raw diff; refuses a stale base", () => {
    const l = ledger();
    const base = resolved().fileSha256;
    const p = previewDraft(l, "a/b", edit((d) => { d.gate.maxFiles = 3; d.gate.maxNonTestLines = 100; d.landing.bugfix = "owner"; d.gate.baseTestRuns = 5; }), base);
    expect(p.changes.map((c) => c.direction)).toEqual(["tighten", "tighten", "tighten", "tighten"]);
    const loose = previewDraft(l, "a/b", edit((d) => { d.gate.baseTestRuns = 3; d.requiredChecks = ["Gate", "Other"]; d.gate.maxFiles = 3; }), base);
    expect(loose.loosens).toBe(true);
    expect(loose.changes[0]!.direction).toBe("loosen");
    expect(loose.rawDiff.some((x) => x.op === "-") && loose.rawDiff.some((x) => x.op === "+")).toBe(true);
    expect(() => previewDraft(l, "a/b", draft(), "0".repeat(64))).toThrow(/Stale draft/);
    expect(() => previewDraft(l, "a/b", { version: 1 }, base)).toThrow(/Invalid draft/);
    expect(() => previewDraft(l, "x/y", draft(), base)).toThrow(/Unknown repo/);
  });

  it("lineDiff keeps changed lines with two lines of context", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8"].join("\n");
    const b = ["1", "2", "3", "4", "X", "6", "7", "8"].join("\n");
    expect(lineDiff(a, b).map((x) => `${x.op}${x.text}`)).toEqual([" 3", " 4", "-5", "+X", " 6", " 7"]);
  });
});

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

  it("dry-run previews without ever calling the runner; a stale base is refused", async () => {
    const t = await start();
    try {
      const loosening = t.body({ draft: edit((d) => { d.gate.maxFiles = 3; d.gate.baseTestRuns = 3; d.requiredChecks = ["Gate", "Other"]; }) });
      const ok = await t.post(t.good, loosening);
      expect(ok.status).toBe(200);
      const json = await ok.json();
      expect(json.preview.loosens).toBe(true);
      expect(json.preview.changes[0].direction).toBe("loosen");
      expect(t.fake.calls).toEqual([]);
      const stale = await t.post(t.good, t.body({ baseFileSha256: "1".repeat(64) }));
      expect(stale.status).toBe(409);
      expect((await stale.json()).error).toMatch(/Stale draft/);
      expect((await t.post(t.good, "not json")).status).toBe(400);
      expect(t.fake.calls).toEqual([]);
    } finally {
      t.server.close();
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

describe("workflow editor UI", () => {
  const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: el }));

  it("renders the Pipeline's draft values in the editor", () => {
    const l = ledger();
    const repo = buildWorkflowsState(l).repos[0]!;
    expect(repo.draft?.landing.bugfix).toBe("autonomous");
    const out = html(createElement(WorkflowEditor, { repo: "a/b", initial: repo.draft!, baseFileSha256: repo.fileSha256! }));
    expect(out).toContain("Edit workflow");
    expect(out).toContain("npm test");
    expect(out).toContain("Scout bug-hunt");
    expect(out).toContain("Preview");
  });

  it("renders the loosened-field warning in red and lists loosened fields first", () => {
    const out = html(
      createElement(PreviewView, {
        preview: {
          changes: [{ field: "gate.baseTestRuns", direction: "loosen" }, { field: "gate.maxFiles", direction: "tighten" }],
          loosens: true,
          rawDiff: [{ op: "-", text: "  \"baseTestRuns\": 4" }, { op: "+", text: "  \"baseTestRuns\": 3" }],
        },
      }),
    );
    expect(out).toContain("This change loosens a limit");
    expect(out).toContain("policy:loosens");
    expect(out.indexOf("gate.baseTestRuns")).toBeLessThan(out.indexOf("gate.maxFiles"));
    expect(out).toContain("LOOSENS");
    expect(out).toContain("baseTestRuns");
  });

  it("treats draft text as text, never HTML", () => {
    const d = structuredClone(draft());
    d.review = { rubric: "<script>alert(1)</script>" };
    const out = html(createElement(WorkflowEditor, { repo: "a/b", initial: d, baseFileSha256: "0".repeat(64) }));
    expect(out).not.toContain("<script>alert(1)</script>");
  });
});
