import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { ingestImage } from "../src/core/pitch-ingest.js";
import { assertBindable, startUiServer } from "../src/core/ui-server.js";
import { Ledger } from "../src/ledger/store.js";

function bundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-ui-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Archangel</title><div id=root></div>");
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

describe("ui server exposure", () => {
  it("refuses a non-loopback host without --allow-remote", async () => {
    expect(() => assertBindable("0.0.0.0", false)).toThrow(/non-loopback/);
    await expect(startUiServer(new Ledger(":memory:"), { host: "0.0.0.0", port: 0, uiDir: bundle() })).rejects.toThrow(/allow-remote/);
    expect(() => assertBindable("0.0.0.0", true)).not.toThrow();
  });

  it("serves read-only: no writes, no path traversal out of the bundle", async () => {
    const server = await startUiServer(new Ledger(":memory:"), { host: "127.0.0.1", port: 0, uiDir: bundle() });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
      expect((await fetch(base, { method: "POST" })).status).toBe(405);
    } finally {
      server.close();
    }
  });

  it("serves a pitch asset only by the hash of a stored attachment, with locked-down headers", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-assets-"));
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#369" } }).png().toBuffer();
    const { sha256, mime, width, height, bytes } = await ingestImage(png, dataDir);
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    ledger.recordPitchAttachment({ issueNumber: 1, kind: "repo", sha256, mime, width, height, bytes, caption: "c", source: "a.png@m" });
    // A file in the asset dir that no pitch row names must stay unreachable.
    const stray = "a".repeat(64);
    fs.writeFileSync(path.join(dataDir, "pitch-assets", `${stray}.png`), png);
    const server = await startUiServer(ledger, { host: "127.0.0.1", port: 0, uiDir: bundle(), dataDir, allowRemote: true });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/pitch-asset`;
      const ok = await fetch(`${base}/${sha256}`);
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer()).equals(fs.readFileSync(path.join(dataDir, "pitch-assets", `${sha256}.png`)))).toBe(true);
      expect(Object.fromEntries(["content-type", "x-content-type-options", "content-security-policy", "cross-origin-resource-policy"].map((h) => [h, ok.headers.get(h)]))).toEqual({
        "content-type": "image/png",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'",
        "cross-origin-resource-policy": "same-origin",
      });
      expect(ok.headers.get("cache-control")).toContain("immutable");
      expect((await fetch(`${base}/${stray}`)).status).toBe(404);
      for (const bad of ["..%2F..%2Fetc%2Fpasswd", `${sha256}.png`, "short"]) expect((await fetch(`${base}/${bad}`)).status).toBe(400);
    } finally {
      server.close();
    }
  });
});
