import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertBindable, startUiServer } from "../src/core/ui-server.js";
import { buildUiState } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";

const NOW = 10 * 86_400_000;
const EVIL = "<script>alert(1)</script>";

function fixture() {
  const l = new Ledger(":memory:", { repo: "a/b" });
  const mk = (issue: number, title: string, phase: Parameters<Ledger["transition"]>[2] | null, now = NOW - 3_600_000) => {
    const t = l.upsertThread({ issueNumber: issue, title, bodySha256: `s${issue}`, now });
    if (phase) l.transition(issue, t.version, phase, { now });
  };
  mk(1, EVIL, { kind: "needs_you", code: "review_vetoed", reason: "x", resumeTo: { kind: "queued" } } as never);
  mk(2, "queued one", null);
  mk(3, "recently done", { kind: "done", outcome: "merged" });
  mk(4, "old done", { kind: "done", outcome: "merged" }, NOW - 8 * 86_400_000);
  l.recordScoutProposal({ issueNumber: 2, scoutName: "bug-hunt", contentSha256: "c", titleFp: "f", autoPromoted: true, now: NOW });
  l.recordScoutProposal({ issueNumber: 99, scoutName: "bug-hunt", contentSha256: "c2", titleFp: "f2", now: NOW });
  return l;
}

describe("buildUiState", () => {
  it("groups threads by stage and reports needs-you, outcomes, autonomy and scouts", () => {
    const s = buildUiState(fixture(), NOW);
    expect(s.needsYou).toHaveLength(1);
    expect(s.needsYou[0]).toMatchObject({ issueNumber: 1, decisionClass: "live infrastructure" });
    expect(s.needsYou[0]!.recommendation).toContain("reviewer findings");
    expect(s.stages["Needs you"]).toHaveLength(1);
    expect(s.stages.Queued.map((i) => i.issueNumber)).toEqual([2]);
    expect(s.stages["Done in last 7 days"].map((i) => i.issueNumber)).toEqual([3]);
    expect(s.stages["Done in last 7 days"][0]!.phase).toBe("merged");
    expect(s.stages.Queued[0]!.phase).toBe("queued");
    expect(s.outcomes.mergedFixes).toBe(2);
    expect(s.autonomySteps["a/b"]).toBeTypeOf("number");
    expect(s.scouts.find((p) => p.issueNumber === 2)).toMatchObject({ autoPromoted: true, hasThread: true });
    expect(s.scouts.find((p) => p.issueNumber === 99)).toMatchObject({ autoPromoted: false, hasThread: false });
  });

  it("handles an empty ledger without dividing by zero", () => {
    const s = buildUiState(new Ledger(":memory:"), NOW);
    expect(s.outcomes.costUsdPerFix).toBeNull();
    expect(s.needsYou).toEqual([]);
  });
});

function bundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-ui-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Archangel</title><div id=root></div>");
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

describe("ui server", () => {
  it("refuses a non-loopback host without --allow-remote", async () => {
    expect(() => assertBindable("0.0.0.0", false)).toThrow(/non-loopback/);
    await expect(startUiServer(new Ledger(":memory:"), { host: "0.0.0.0", port: 0, uiDir: bundle() })).rejects.toThrow(/allow-remote/);
    expect(() => assertBindable("0.0.0.0", true)).not.toThrow();
    expect(() => assertBindable("127.0.0.1", false)).not.toThrow();
  });

  it("fails clearly when the bundle is missing", async () => {
    await expect(startUiServer(new Ledger(":memory:"), { host: "127.0.0.1", port: 0, uiDir: "/nonexistent/arc-ui" })).rejects.toThrow(/UI bundle not found.*npm run build/);
  });

  it("serves the bundle and JSON read-only on loopback", async () => {
    const server = await startUiServer(fixture(), { host: "127.0.0.1", port: 0, uiDir: bundle() });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/api/state`).then((r) => r.json())).needsYou).toHaveLength(1);
      const state = await fetch(`${base}/api/state`).then((r) => r.json());
      expect(Object.keys(state)).toEqual(expect.arrayContaining(["generatedAt", "needsYou", "stages", "outcomes", "autonomySteps", "scouts"]));
      expect(state.daily).toHaveLength(14);
      const index = await fetch(base);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(await index.text()).toContain('<div id=root>');
      expect(await fetch(`${base}/assets/app.js`).then((r) => r.text())).toBe("console.log(1)");
      expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
      expect((await fetch(base, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("answers 503 ledger_schema_behind and keeps serving when the schema is behind", async () => {
    const ledger = fixture();
    const server = await startUiServer(ledger, { host: "127.0.0.1", port: 0, uiDir: bundle() });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // Simulate a Ledger whose schema is behind (e.g. opened read-only before a migration ran).
      (ledger as unknown as { db: { exec(sql: string): void } }).db.exec("DROP TABLE threads");
      const res = await fetch(`${base}/api/state`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "ledger_schema_behind" });
      expect((await fetch(`${base}/api/workflows`)).status).toBe(503);
      expect((await fetch(base)).status).toBe(200); // the server is still alive
    } finally {
      server.close();
    }
  });
});
