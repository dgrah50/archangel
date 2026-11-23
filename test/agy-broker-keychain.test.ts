import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGY_NO_KEYCHAIN_PROFILE, AGY_TOKEN_FILE, agyBrokerAdapter } from "../src/compute/agy-broker-adapter.js";

// The refresh must never reach macOS's keychain services: that is what pops "Keychain Not Found" every ~30 minutes.
test("agy broker refresh profile denies the keychain services and is a valid Seatbelt profile", () => {
  for (const svc of ["com.apple.SecurityServer", "com.apple.securityd"]) expect(AGY_NO_KEYCHAIN_PROFILE).toContain(svc);
  expect(AGY_NO_KEYCHAIN_PROFILE).toContain("(deny mach-lookup");
  expect(AGY_NO_KEYCHAIN_PROFILE).toContain("/Library/Keychains");
  if (process.platform !== "darwin") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-kc-test-"));
  try {
    const profile = path.join(dir, "p.sb");
    fs.writeFileSync(profile, AGY_NO_KEYCHAIN_PROFILE);
    expect(spawnSync("sandbox-exec", ["-f", profile, "/usr/bin/true"]).status).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
