import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { startUiServer } from "../src/core/ui-server.js";
import { Ledger } from "../src/ledger/store.js";

it("GET /api/pitches needs the token and is 403 in remote mode", async () => {
  const ui = fs.mkdtempSync(path.join(os.tmpdir(), "arc-pitch-ui-"));
  fs.writeFileSync(path.join(ui, "index.html"), "<html><head></head></html>");
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arc-pitch-cfg-")), "archangel.yaml");
  fs.writeFileSync(configPath, "ownerUserId: 42\nprojects:\n  - repo: a/b\n");
  const ledger = new Ledger(":memory:");
  const boot = async (allowRemote: boolean) => {
    const server = await startUiServer(ledger, { host: "127.0.0.1", port: 0, uiDir: ui, configPath, allowRemote, doctor: (async () => ({})) as never });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const token = /name="archangel-token" content="([0-9a-f]+)"/.exec(await (await fetch(base)).text())?.[1];
    return { server, base, token };
  };
  const local = await boot(false);
  const remote = await boot(true);
  try {
    expect((await fetch(`${local.base}/api/pitches`)).status).toBe(401);
    expect((await fetch(`${local.base}/api/pitches`, { headers: { "x-archangel-token": local.token! } })).status).toBe(200);
    expect((await fetch(`${remote.base}/api/pitches`, { headers: { "x-archangel-token": local.token! } })).status).toBe(403);
  } finally {
    local.server.close();
    remote.server.close();
  }
});
