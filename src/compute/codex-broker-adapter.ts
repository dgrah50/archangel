import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tryParseJson } from "../core/json.js";
import type { BrokerAdapter } from "./token-broker.js";

/** The Sail secret the dedicated account's access token lives in. */
export const CODEX_BROKER_SECRET = "ARCHANGEL_CODEX_ACCESS";
/** The box env var holding the placeholder the synthetic codex auth.json carries. */
export const CODEX_PLACEHOLDER_ENV = "ARCHANGEL_CODEX_PLACEHOLDER";
export const CODEX_BROKER_ID = "codex";
const REFRESH_TIMEOUT_MS = 60_000;

/**
 * Lets codex itself refresh the dedicated account (`codex app-server`, JSON-RPC `account/read {refreshToken:true}`, OpenAI's
 * supported path: no hand-rolled oauth call) and then reads the fresh access token from that home's auth.json. The home must be
 * a dedicated ChatGPT login stored as a file (`cli_auth_credentials_store = "file"`), never the owner's main login.
 */
export function codexBrokerAdapter(home: string): BrokerAdapter {
  return {
    id: CODEX_BROKER_ID,
    secretName: CODEX_BROKER_SECRET,
    async refresh() {
      await forceRefresh(home);
      const auth = readAuth(home);
      const expiresAt = jwtExpiryMs(auth.accessToken);
      // codex refreshes inside this call; an access token that is still about to expire means it did not.
      if (expiresAt - Date.now() < 5 * 60_000) throw new Error("codex did not produce a fresh access token (login expired or revoked?)");
      return { accessToken: auth.accessToken, expiresAt, accountId: auth.accountId };
    },
  };
}

function readAuth(home: string): { accessToken: string; accountId: string } {
  const file = path.join(home, "auth.json");
  if (!fs.existsSync(file)) throw new Error(`no auth.json in ${home}: log in with CODEX_HOME=${home} codex login (file credential store)`);
  const parsed = tryParseJson(fs.readFileSync(file, "utf8"));
  const v = (parsed.ok ? parsed.value : {}) as { auth_mode?: string; tokens?: { access_token?: string; account_id?: string } };
  if (v.auth_mode !== "chatgpt" || !v.tokens?.access_token || !v.tokens.account_id) throw new Error(`${file} is not a ChatGPT login with an access token and account id`);
  return { accessToken: v.tokens.access_token, accountId: v.tokens.account_id };
}

/** The access token's `exp` claim, in ms. A token whose lifetime cannot be read is an error: nothing can be scheduled safely. */
export function jwtExpiryMs(token: string): number {
  const payload = token.split(".")[1];
  const parsed = payload ? tryParseJson(Buffer.from(payload, "base64url").toString("utf8")) : null;
  const exp = parsed?.ok ? (parsed.value as { exp?: unknown }).exp : undefined;
  if (typeof exp !== "number") throw new Error("the access token has no readable exp claim: cannot schedule refreshes");
  return exp * 1000;
}

function forceRefresh(home: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Only this home's directory is passed; nothing else from this machine's env reaches codex but PATH.
    const child = spawn("codex", ["app-server"], { env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const done = (err?: Error) => {
      clearTimeout(timer);
      child.kill();
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => done(new Error("codex app-server did not answer in time")), REFRESH_TIMEOUT_MS);
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    child.on("error", (e) => done(e));
    child.on("exit", () => done(new Error(`codex app-server exited early: ${stderr.trim().slice(-200)}`)));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = tryParseJson(line);
        if (!msg.ok) continue;
        const m = msg.value as { id?: number; error?: { message?: string } };
        if (m.error) return done(new Error(`codex app-server: ${m.error.message ?? "error"}`));
        if (m.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: true } });
        } else if (m.id === 2) done();
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "archangel-broker", version: "1" } } });
  });
}
