import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverInstallation, upsertEnvFile } from "../scripts/github-app-ids.js";

const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function fakeGithub(installs: { id: number; account: { login: string } }[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const auth = new Headers(init?.headers).get("authorization");
    if (u.endsWith("/app/installations")) {
      return auth?.startsWith("Bearer ") ? Response.json(installs) : new Response("no", { status: 401 });
    }
    if (u.endsWith("/users/my-app%5Bbot%5D")) return Response.json({ id: 777 });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

test("App setup finds the installation and bot id, asks when ambiguous, keeps .env 0600", async () => {
  const base = { appId: "1", pem, slug: "my-app", pollMs: 1 };
  const one = await discoverInstallation({
    ...base,
    fetch: fakeGithub([{ id: 42, account: { login: "me" } }]),
    choose: async () => {
      throw new Error("must not ask");
    },
  });
  expect(one).toEqual({ installationId: "42", botUserId: "777" });

  const two = [
    { id: 1, account: { login: "a" } },
    { id: 2, account: { login: "b" } },
  ];
  const picked = await discoverInstallation({ ...base, fetch: fakeGithub(two), choose: async (i) => i[1]! });
  expect(picked.installationId).toBe("2");
  await expect(
    discoverInstallation({
      ...base,
      fetch: fakeGithub(two),
      choose: async () => {
        throw new Error("ambiguous");
      },
    }),
  ).rejects.toThrow("ambiguous");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envtest-"));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "KEEP=me\nARCHANGEL_GITHUB_INSTALLATION_ID=\n", { mode: 0o644 });
  upsertEnvFile(envPath, { ARCHANGEL_GITHUB_INSTALLATION_ID: "42", ARCHANGEL_GITHUB_BOT_USER_ID: "777" });
  expect(fs.readFileSync(envPath, "utf8")).toBe("KEEP=me\nARCHANGEL_GITHUB_INSTALLATION_ID=42\nARCHANGEL_GITHUB_BOT_USER_ID=777\n");
  expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
});
