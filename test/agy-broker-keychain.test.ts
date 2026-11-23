import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canSandbox } from "./helpers/can-sandbox.js";
import { AGY_NO_KEYCHAIN_PROFILE, AGY_TOKEN_FILE, agyBrokerAdapter } from "../src/compute/agy-broker-adapter.js";

// What raised "Keychain Not Found" at every refresh: agy stores the fresh token through /usr/bin/security, which in a HOME with no
// keychain asks authd for a login keychain. Under the profile that write must be refused outright, with nobody asked.
test.skipIf(!canSandbox)("under the agy keychain-deny profile a keychain write in a HOME with no keychain is refused without a dialog", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-kc-test-"));
  try {
    const res = spawnSync("sandbox-exec", ["-p", AGY_NO_KEYCHAIN_PROFILE, "/usr/bin/security", "add-generic-password", "-a", "archangel-test", "-s", "archangel-test", "-w", "x"], {
      env: { PATH: "/usr/bin:/bin", HOME: home },
      encoding: "utf8",
      timeout: 10_000,
    });
    // Denied by the sandbox; a dialog would instead block until answered (the timeout) and end as "canceled".
    expect(res.stderr).toContain("authorization was denied");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The reviewer may be running agy on this very login while the broker refreshes it: the account's own file must not change.
test("agy broker refresh works on a private copy and leaves the account's login file untouched", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-test-"));
  try {
    const file = path.join(home, AGY_TOKEN_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const login = JSON.stringify({ auth_method: "consumer", token: { access_token: "old", refresh_token: "r", expiry: new Date(Date.now() + 60_000).toISOString() } });
    fs.writeFileSync(file, login);
    const fresh = await agyBrokerAdapter(home, async (scratch) => {
      expect(scratch).not.toBe(home);
      const copy = JSON.parse(fs.readFileSync(path.join(scratch, AGY_TOKEN_FILE), "utf8"));
      expect(Date.parse(copy.token.expiry)).toBeLessThan(Date.now());
      fs.writeFileSync(path.join(scratch, AGY_TOKEN_FILE), JSON.stringify({ ...copy, token: { ...copy.token, access_token: "new", expiry: new Date(Date.now() + 3_600_000).toISOString() } }));
    }).refresh();
    expect(fresh.accessToken).toBe("new");
    expect(fs.readFileSync(file, "utf8")).toBe(login);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
