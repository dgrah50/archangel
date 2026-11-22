import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
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
});
