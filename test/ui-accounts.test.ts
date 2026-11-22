import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { startUiServer } from "../src/core/ui-server.js";
import { Ledger } from "../src/ledger/store.js";

it("GET /api/accounts needs the token, is 403 in remote mode, and never reads inside an account home", async () => {
  const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
  const home = tmp("arc-acct-home-");
  fs.writeFileSync(path.join(home, "auth-token.json"), '{"token":"SECRET-TOKEN-VALUE"}');
  const ui = tmp("arc-acct-ui-");
  fs.writeFileSync(path.join(ui, "index.html"), "<html><head></head></html>");
  const configPath = path.join(tmp("arc-acct-cfg-"), "archangel.yaml");
  fs.writeFileSync(configPath, `ownerUserId: 42\naccounts:\n  - {id: claude-a, provider: claude, home: ${home}, maxAttemptsPerDay: 5}\n  - {id: codex, provider: codex}\n  - {id: agy, provider: agy}\nprojects:\n  - repo: a/b\n`);
  const ledger = new Ledger(":memory:");
  ledger.setAccountCooldown("claude-a", 60_000, "usage limit reached");
  const boot = async (allowRemote: boolean) => {
    const server = await startUiServer(ledger, { host: "127.0.0.1", port: 0, uiDir: ui, configPath, allowRemote, doctor: (async () => ({})) as never });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const token = /name="archangel-token" content="([0-9a-f]+)"/.exec(await (await fetch(base)).text())?.[1];
    return { server, base, token };
  };
  const local = await boot(false);
  const remote = await boot(true);
  try {
    expect((await fetch(`${local.base}/api/accounts`)).status).toBe(401);
    const ok = await fetch(`${local.base}/api/accounts`, { headers: { "x-archangel-token": local.token! } });
    expect(ok.status).toBe(200);
    const text = await ok.text();
    const claude = (JSON.parse(text) as { accounts: Array<{ id: string; home: string | null; cooldownUntil: number | null; lastSwitch: { reason: string } | null }> }).accounts.find((a) => a.id === "claude-a")!;
    expect(claude.home).toBe(path.resolve(home));
    expect(claude.cooldownUntil).not.toBeNull();
    expect(claude.lastSwitch?.reason).toBe("usage limit reached");
    expect(text).not.toContain("SECRET-TOKEN-VALUE");
    expect(text).not.toContain("auth-token");
    expect(remote.token).toBeUndefined();
    expect((await fetch(`${remote.base}/api/accounts`, { headers: { "x-archangel-token": local.token! } })).status).toBe(403);
  } finally {
    local.server.close();
    remote.server.close();
  }
});
