import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryParseJson } from "../core/json.js";
import type { BrokerAdapter } from "./token-broker.js";

/** The Sail secret the dedicated Google account's access token lives in. */
export const AGY_BROKER_SECRET = "ARCHANGEL_AGY_ACCESS";
/** The box env var holding the placeholder the synthetic agy login file carries. */
export const AGY_PLACEHOLDER_ENV = "ARCHANGEL_AGY_PLACEHOLDER";
export const AGY_BROKER_ID = "agy";
/** Where agy keeps its OAuth login when no OS keyring is usable (a HOME with no keychain, a box with no D-Bus), relative to HOME. */
export const AGY_TOKEN_FILE = ".gemini/antigravity-cli/antigravity-oauth-token";
const REFRESH_TIMEOUT_MS = 90_000;

/**
 * Seatbelt profile that makes agy's keychain attempt fail silently. With no keychain in the profile HOME, macOS shows a
 * "Keychain Not Found" dialog when agy asks securityd; denying the Security services (and the keychain dirs) turns that into
 * a plain error, and agy falls back to its token file. Everything else is allowed: agy needs its own binary, the network and HOME.
 */
export const AGY_NO_KEYCHAIN_PROFILE = [
  "(version 1)",
  "(allow default)",
  '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent") (global-name "com.apple.security.authhost") (global-name "com.apple.securityd.xpc"))',
  '(deny file-read* file-write* (regex #"/Library/Keychains(/|$)"))',
  "",
].join("\n");

/**
 * The command that runs agy for an account. An account with its own home has no keychain there, so agy runs under the keychain-deny
 * profile (inline, no temp file) and keeps its login in a file. The default home is the owner's real keychain and runs unchanged.
 */
export function agyCommand(account: { home?: string } | undefined, args: string[]): { cmd: string; args: string[] } {
  if (!account?.home) return { cmd: "agy", args };
  if (process.platform !== "darwin") throw new Error("an agy account with its own home needs macOS sandbox-exec to keep agy off the keychain");
  return { cmd: "sandbox-exec", args: ["-p", AGY_NO_KEYCHAIN_PROFILE, "agy", ...args] };
}

/**
 * Lets agy itself refresh the dedicated Google account and then reads the fresh access token from that profile's token file. The
 * profile is a HOME of its own (never the owner's): there agy finds no keychain and keeps its login in a file. agy only refreshes an
 * expired token, so the file's expiry is set in the past first and a cheap authenticated command (`agy models`) is run; agy then
 * refreshes through Google and rewrites the file. It runs under a sandbox-exec profile denying the keychain services so macOS shows no dialog. Google does not rotate the refresh token, so this does not fight a box or the owner.
 */
export function agyBrokerAdapter(home: string): BrokerAdapter {
  return {
    id: AGY_BROKER_ID,
    secretName: AGY_BROKER_SECRET,
    async refresh() {
      const before = readLogin(home);
      writeLogin(home, { ...before.raw, token: { ...before.raw.token, expiry: "2000-01-01T00:00:00Z" } });
      await runAgy(home);
      const after = readLogin(home);
      const expiresAt = Date.parse(after.expiry);
      if (after.accessToken === before.accessToken || !(expiresAt - Date.now() > 5 * 60_000)) {
        throw new Error("agy did not produce a fresh access token (login expired or revoked?)");
      }
      return { accessToken: after.accessToken, expiresAt, accountId: "consumer" };
    },
  };
}

type Login = { token: { access_token?: string; expiry?: string; [k: string]: unknown }; [k: string]: unknown };

function readLogin(home: string): { raw: Login; accessToken: string; expiry: string } {
  const file = path.join(home, AGY_TOKEN_FILE);
  if (!fs.existsSync(file)) throw new Error(`no agy login in ${home}: log the dedicated account in with HOME=${home} agy`);
  const parsed = tryParseJson(fs.readFileSync(file, "utf8"));
  const raw = (parsed.ok ? parsed.value : {}) as Login;
  const t = raw.token;
  if (!t?.access_token || typeof t.expiry !== "string" || (raw as { auth_method?: string }).auth_method !== "consumer") throw new Error(`${file} is not a consumer agy login with an access token`);
  return { raw, accessToken: t.access_token, expiry: t.expiry };
}

function writeLogin(home: string, login: Login): void {
  fs.writeFileSync(path.join(home, AGY_TOKEN_FILE), JSON.stringify(login), { mode: 0o600 });
}

/** Only this profile's HOME is passed; nothing else from this machine's env reaches agy but PATH. The command's own exit code is not the signal: the token file is. */
function runAgy(home: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") throw new Error("the agy broker refresh needs macOS sandbox-exec");
    const profile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "archangel-agy-")), "keychain-deny.sb");
    fs.writeFileSync(profile, AGY_NO_KEYCHAIN_PROFILE);
    const child = spawn("sandbox-exec", ["-f", profile, "agy", "models"], { env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "ignore", "ignore"] });
    const cleanup = () => fs.rmSync(path.dirname(profile), { recursive: true, force: true });
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error("agy did not finish refreshing in time"));
    }, REFRESH_TIMEOUT_MS);
    child.on("error", (e) => {
      cleanup();
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", () => {
      cleanup();
      clearTimeout(timer);
      resolve();
    });
  });
}
