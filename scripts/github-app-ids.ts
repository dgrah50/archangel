import crypto from "node:crypto";
import fs from "node:fs";

type Fetch = typeof fetch;
export type Installation = { id: number; account: { login: string } };

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId }),
  )}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(body), pem);
  return `${body}.${b64url(sig)}`;
}

async function gh<T>(f: Fetch, apiBase: string, path: string, jwt?: string): Promise<T> {
  const res = await f(`${apiBase}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "archangel-setup",
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

/** Poll GET /app/installations until the App is installed; ask `choose` when several exist. */
export async function discoverInstallation(opts: {
  appId: string;
  pem: string;
  slug: string;
  choose: (installs: Installation[]) => Promise<Installation>;
  fetch?: Fetch;
  apiBase?: string;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<{ installationId: string; botUserId: string }> {
  const f = opts.fetch ?? fetch;
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  for (;;) {
    const installs = await gh<Installation[]>(f, apiBase, "/app/installations", appJwt(opts.appId, opts.pem));
    if (installs.length > 0) {
      const picked = installs.length === 1 ? installs[0]! : await opts.choose(installs);
      const bot = await gh<{ id: number }>(f, apiBase, `/users/${encodeURIComponent(`${opts.slug}[bot]`)}`);
      return { installationId: String(picked.id), botUserId: String(bot.id) };
    }
    if (Date.now() > deadline) throw new Error("Timed out waiting for the App to be installed");
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 3000));
  }
}

/** Replace or append KEY=value lines, keeping other content; file stays 0600. */
export function upsertEnvFile(envPath: string, updates: Record<string, string>): void {
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    const line = `${key}=${value}`;
    content = re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`.replace(/^\n/, "");
  }
  fs.writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}
