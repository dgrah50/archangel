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
 * Seatbelt profile that makes agy's keychain use fail silently in a HOME with no keychain. agy reaches the keychain through
 * `/usr/bin/security`, a child that inherits this profile. Reading only fails. Storing a refreshed token is what raises macOS's
 * "Keychain Not Found" dialog: with no default keychain, `security` asks authd for the right to create a login keychain, and authd
 * puts the dialog up. So the profile denies the Security services, the keychain dirs AND obtaining any authorization right: authd
 * then refuses without asking, and agy keeps its login in the token file. Everything else is allowed: agy needs its own binary, the
 * network and HOME.
 */
export const AGY_NO_KEYCHAIN_PROFILE = [
  "(version 1)",
  "(allow default)",
  '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent") (global-name "com.apple.security.authhost") (global-name "com.apple.securityd.xpc"))',
  "(deny authorization-right-obtain)",
  '(deny file-read* file-write* (regex #"/Library/Keychains(/|$)"))',
  "",
].join("\n");

/**
 * The command that runs agy for an account. An account with its own home has no keychain there, so agy runs under the keychain-deny
 * profile (inline, no temp file) and keeps its login in a file. The default home is the owner's real keychain and runs unchanged.
 */
export function agyCommand(account: { home?: string } | undefined, args: string[]): { cmd: string; args: string[] } {
  // The dialog is macOS's: elsewhere there is nothing to deny.
  if (!account?.home || process.platform !== "darwin") return { cmd: "agy", args };
  return { cmd: "sandbox-exec", args: ["-p", AGY_NO_KEYCHAIN_PROFILE, "agy", ...args] };
}

/**
 * The command that runs an account's CLI, whatever its provider. Every start of a CLI that is not an agent run (doctor, usage)
 * builds its command here, so an agy account with its own home is never started without the keychain-deny profile.
 */
export function cliCommand(account: { provider: string; home?: string }, args: string[]): { cmd: string; args: string[] } {
  return account.provider === "agy" ? agyCommand(account, args) : { cmd: account.provider, args };
}

/**
 * Lets agy itself refresh the dedicated Google account and reads the fresh access token it writes. agy only refreshes an expired
 * token, so the refresh runs in a PRIVATE copy of the login: a throwaway HOME holding only the token file, its expiry set in the past,
 * where a cheap authenticated command (`agy models`) makes agy refresh through Google and rewrite that copy. The account's own home is
 * only read. Rewriting its login file instead killed any agy run using the same login at that moment (a review died with
 * "error: interrupted" at each half-hourly refresh). Google does not rotate the refresh token, so the copy and the original both stay
 * valid. It runs through agyCommand, so under the keychain-deny profile: storing the refreshed token would otherwise raise the dialog.
 */
export function agyBrokerAdapter(home: string, refreshIn: (scratchHome: string) => Promise<void> = runAgy): BrokerAdapter {
  return {
    id: AGY_BROKER_ID,
    secretName: AGY_BROKER_SECRET,
    async refresh() {
      const before = readLogin(home);
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-agy-home-"));
      try {
        fs.mkdirSync(path.dirname(path.join(scratch, AGY_TOKEN_FILE)), { recursive: true });
        writeLogin(scratch, { ...before.raw, token: { ...before.raw.token, expiry: "2000-01-01T00:00:00Z" } });
        await refreshIn(scratch);
        const after = readLogin(scratch);
        const expiresAt = Date.parse(after.expiry);
        if (after.accessToken === before.accessToken || !(expiresAt - Date.now() > 5 * 60_000)) {
          throw new Error("agy did not produce a fresh access token (login expired or revoked?)");
        }
        return { accessToken: after.accessToken, expiresAt, accountId: "consumer" };
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
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
    const { cmd, args } = agyCommand({ home }, ["models"]);
    const child = spawn(cmd, args, { env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("agy did not finish refreshing in time"));
    }, REFRESH_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
