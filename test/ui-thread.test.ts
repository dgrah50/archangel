import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { startUiServer } from "../src/core/ui-server.js";
import { buildThreadDetail, readLogs } from "../src/core/ui-thread.js";
import { Ledger } from "../src/ledger/store.js";
import { ThreadDetailPage } from "../ui/src/ThreadDetailPage.js";
import { isLogs, isThreadDetail } from "../ui/src/payload.js";
import { parseRoute } from "../ui/src/route.js";

const NOW = 10 * 86_400_000;
const EVIL = "<script>alert(1)</script>";
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: el }));

function seeded() {
  const l = new Ledger(":memory:", { repo: "a/b" });
  const t = l.upsertThread({ issueNumber: 1, title: EVIL, bodySha256: "s", now: NOW - 5_000_000 });
  const a = l.startAttempt(1, "implement", NOW - 4_000_000);
  l.finishAttempt(a.id, { status: "failed", errorMessage: "Aborted by owner", errorCategory: "aborted", transcriptPath: "/tmp/t.jsonl" }, NOW - 3_900_000);
  l.recordReview({ issueNumber: 1, headSha: "abcdef123456", vendor: "openai", verdict: "veto", findings: [{ file: "x.ts", severity: "major", summary: EVIL }], costUsd: 0, now: NOW - 3_000_000 });
  l.transition(1, t.version, { kind: "done", outcome: "abandoned" }, { now: NOW - 1_000 });
  return l;
}

describe("buildThreadDetail", () => {
  it("merges audit, attempts and reviews oldest first, with an error category and never the raw error text", () => {
    const d = buildThreadDetail(seeded(), "a/b", 1, NOW)!;
    expect(isThreadDetail(d)).toBe(true);
    expect(d.events.map((e) => e.ts)).toEqual([...d.events.map((e) => e.ts)].sort((x, y) => x - y));
    const attempt = d.events.find((e) => e.kind === "attempt")!;
    expect(attempt.tone).toBe("failed");
    expect(JSON.stringify(attempt)).toContain("aborted");
    const review = d.events.find((e) => e.kind === "review")!;
    expect(review.title).toBe("Review by openai: veto");
    expect(review.tone).toBe("failed");
    expect(d.auditTruncated).toBe(false);
  });
  it("is null for an unknown Thread and does not leak another repo's Thread", () => {
    const l = seeded();
    expect(buildThreadDetail(l, "a/b", 99, NOW)).toBeNull();
    expect(buildThreadDetail(l, "c/d", 1, NOW)).toBeNull();
  });
});

describe("readLogs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-log-"));
  const file = path.join(dir, "l.jsonl");
  const rec = (o: object) => JSON.stringify(o);
  fs.writeFileSync(file, [rec({ ts: "2026-01-01T00:00:01Z", level: "info", event: "e1", repo: "a/b", issue: 1, message: "one", data: { secret: "x" } }), rec({ repo: "a/b", issue: 2, message: "other" }), "not json", rec({ ts: "2026-01-01T00:00:02Z", level: "error", event: "e2", repo: "a/b", issue: 1, message: "two" })].join("\n") + "\n");
  it("filters to the Thread, skips torn lines, and never returns data", () => {
    const r = readLogs(file, "a/b", 1, 100, NOW);
    expect(isLogs(r)).toBe(true);
    expect(r.entries.map((e) => e.message)).toEqual(["one", "two"]);
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(readLogs(file, "a/b", 1, 1, NOW).entries.map((e) => e.message)).toEqual(["two"]);
  });
  it("reports a missing file distinctly from an empty result", () => {
    expect(readLogs(path.join(dir, "nope"), "a/b", 1, 10).missing).toBe(true);
    expect(readLogs(null, "a/b", 1, 10).missing).toBe(true);
    expect(readLogs(file, "a/b", 7, 10)).toMatchObject({ missing: false, entries: [] });
  });
});

describe("server routes", () => {
  it("serves detail and logs, 404s unknown Threads and 400s bad input", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-ui-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head></html>");
    const server = await startUiServer(seeded(), { host: "127.0.0.1", port: 0, uiDir: dir });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ok = await fetch(`${base}/api/threads/a/b/1`);
      expect(ok.status).toBe(200);
      expect(isThreadDetail(await ok.json())).toBe(true);
      expect((await fetch(`${base}/api/threads/a/b/99`)).status).toBe(404);
      expect((await fetch(`${base}/api/threads/a/b/0`)).status).toBe(400);
      expect((await fetch(`${base}/api/threads/..%2F/b/1`)).status).toBe(404);
      expect((await fetch(`${base}/api/logs?repo=a/b&issue=1`)).status).toBe(200);
      expect((await fetch(`${base}/api/logs?repo=a/b`)).status).toBe(400);
      expect((await fetch(`${base}/api/threads/a/b/1`, { method: "POST" })).status).toBe(405);
    } finally {
      server.close();
    }
  });
});

describe("ThreadDetailPage", () => {
  const feed = <T,>(data: T | null, error: string | null = null) => ({ data, at: data ? NOW : null, error });
  const page = (thread: ReturnType<typeof feed<ReturnType<typeof buildThreadDetail>>>, logs: ReturnType<typeof feed<unknown>> = feed(null)) =>
    html(createElement(ThreadDetailPage, { item: { repo: "a/b", issue: 1 }, thread: thread as never, logs: logs as never, now: NOW, onRetry: () => {} }));
  it("renders untrusted text as text, marks failed rows and offers Copy path", () => {
    const out = page(feed(buildThreadDetail(seeded(), "a/b", 1, NOW)), feed({ generatedAt: NOW, missing: false, entries: [] }));
    expect(out).not.toContain(EVIL);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain('role="alert"');
    expect(out).toContain("Copy path");
    expect(out).toContain("No log entries for this Thread.");
    expect(out).toContain('href="#/threads"');
  });
  it("loading, error with Retry, and a missing log file are distinct", () => {
    expect(page(feed(null))).toContain("Loading thread...");
    const err = page(feed(null, "/api/threads/a/b/1: no Thread a/b#1"));
    expect(err).toContain("could not be loaded");
    expect(err).toContain("Retry");
    const missing = page(feed(buildThreadDetail(seeded(), "a/b", 1, NOW)), feed({ generatedAt: NOW, missing: true, entries: [] }));
    expect(missing).toContain("does not exist yet");
  });
  it("parses thread routes", () => {
    expect(parseRoute("#/threads/a/b/1")).toEqual({ page: "thread", item: { repo: "a/b", issue: 1 } });
    expect(parseRoute("#/threads/a/1").page).toBe("not-found");
  });
});
