import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { startUiServer } from "../src/core/ui-server.js";
import { Ledger } from "../src/ledger/store.js";

it("GET /api/accounts needs the token, is 403 in remote mode, and never returns a token from an account home", async () => {
  const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
  const home = tmp("arc-acct-home-");
  fs.writeFileSync(path.join(home, "auth-token.json"), '{"token":"SECRET-TOKEN-VALUE"}');
  const codexHome = tmp("arc-acct-codex-");
  fs.mkdirSync(path.join(codexHome, "sessions"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"token":"SECRET-TOKEN-VALUE"}');
  fs.writeFileSync(path.join(codexHome, "sessions", "rollout-1.jsonl"), '{"rate_limits":{"primary":{"used_percent":41}}}\n');
  const ui = tmp("arc-acct-ui-");
  fs.writeFileSync(path.join(ui, "index.html"), "<html><head></head></html>");
  const configPath = path.join(tmp("arc-acct-cfg-"), "archangel.yaml");
  fs.writeFileSync(configPath, `ownerUserId: 42\naccounts:\n  - {id: claude-a, provider: claude, home: ${home}, maxAttemptsPerDay: 5}\n  - {id: codex, provider: codex, home: ${codexHome}}\n  - {id: agy, provider: agy}\nprojects:\n  - repo: a/b\n`);
  const ledger = new Ledger(":memory:");
  ledger.setAccountCooldown("claude-a", 60_000, "usage limit reached");
  // Claude and agy usage is whatever the CLI itself prints for `/usage`; the runner stands in for the CLI.
  const runs: Array<{ cli: string; configDir?: string }> = [];
  const usageRunner = async (cli: "claude" | "agy", env: NodeJS.ProcessEnv) => {
    runs.push({ cli, configDir: env.CLAUDE_CONFIG_DIR });
    return cli === "claude"
      ? "Current session: 22% used · resets Nov 23 at 1:39am (America/Cayman)\nCurrent week (all models): 13% used · resets Nov 29 at 12:59pm (America/Cayman)\n"
      : "Gemini Models\tFive Hour Limit Remaining\t99%\t2999-11-23T07:26:23Z\n";
  };
  const boot = async (allowRemote: boolean) => {
    const server = await startUiServer(ledger, { host: "127.0.0.1", port: 0, uiDir: ui, configPath, allowRemote, doctor: (async () => ({})) as never, usageRunner });
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
    await ok.text();
    // The first poll starts the CLI runs; the next one carries their readings (cached, so a third does not run again).
    await new Promise((r) => setTimeout(r, 20));
    const text = await (await fetch(`${local.base}/api/accounts`, { headers: { "x-archangel-token": local.token! } })).text();
    await fetch(`${local.base}/api/accounts`, { headers: { "x-archangel-token": local.token! } });
    expect(runs).toEqual([{ cli: "claude", configDir: home }, { cli: "agy", configDir: undefined }]);
    const rows = (JSON.parse(text) as { accounts: Array<{ id: string; usage: { windows: Array<{ label: string; usedPercent: number }> } | null }> }).accounts;
    expect(rows.find((a) => a.id === "claude-a")!.usage?.windows.map((w) => `${w.label} ${w.usedPercent}`)).toEqual(["5 h 22", "week 13"]);
    expect(rows.find((a) => a.id === "agy")!.usage?.windows.map((w) => `${w.label} ${w.usedPercent}`)).toEqual(["Gemini Models 5 h 1"]);
    const claude = (JSON.parse(text) as { accounts: Array<{ id: string; home: string | null; cooldownUntil: number | null; lastSwitch: { reason: string } | null }> }).accounts.find((a) => a.id === "claude-a")!;
    expect(claude.home).toBe(path.resolve(home));
    expect(claude.cooldownUntil).not.toBeNull();
    expect(claude.lastSwitch?.reason).toBe("usage limit reached");
    // The Codex usage reading comes from its session log; the auth file next to it is never read.
    expect(rows.find((a) => a.id === "codex")!.usage?.windows[0]?.usedPercent).toBe(41);
    expect(text).not.toContain("SECRET-TOKEN-VALUE");
    expect(text).not.toContain("auth-token");
    expect(remote.token).toBeUndefined();
    expect((await fetch(`${remote.base}/api/accounts`, { headers: { "x-archangel-token": local.token! } })).status).toBe(403);
  } finally {
    local.server.close();
    remote.server.close();
  }
});
