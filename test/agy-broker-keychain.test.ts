import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGY_NO_KEYCHAIN_PROFILE } from "../src/compute/agy-broker-adapter.js";

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
