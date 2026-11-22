import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { publishShots } from "../src/core/pr-shots.js";
import { ASSETS_REF, GitHubAppClient } from "../src/github/client.js";

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

describe("assets branch", () => {
  it("the push method writes only archangel/assets under prs/ or pitches/, as an orphan branch on first use", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const calls: string[] = [];
    let commitBody: { parents?: string[] } = {};
    let refBody: { ref?: string } = {};
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const line = `${req.method} ${req.url}`;
        calls.push(line);
        const json = (status: number, v: unknown) => (res.writeHead(status, { "Content-Type": "application/json" }), res.end(JSON.stringify(v)));
        if (line.includes("/access_tokens")) return json(201, { token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: "write" } });
        if (line.startsWith("GET") && line.includes("/git/ref/")) return json(404, { message: "Not Found" });
        if (line.endsWith("/git/blobs")) return json(201, { sha: "b".repeat(40) });
        if (line.endsWith("/git/trees")) return json(201, { sha: "t".repeat(40) });
        if (line.endsWith("/git/commits")) return ((commitBody = JSON.parse(body)), json(201, { sha: "c".repeat(40) }));
        if (line.endsWith("/git/refs")) return ((refBody = JSON.parse(body)), json(201, {}));
        return json(500, { message: `unexpected ${line}` });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const gh = new GitHubAppClient({ owner: "acme", repo: "app", appId: "1", installationId: 777, privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), apiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
      const file = (p: string) => ({ path: p, bytes: Buffer.from("x") });
      const ok = `prs/7/${"a".repeat(64)}.png`;
      const bad: Array<[string, string, string]> = [
        ["a factory branch", "refs/heads/factory/7", ok],
        ["main", "refs/heads/main", ok],
        ["another dir", ASSETS_REF, `src/${"a".repeat(64)}.png`],
        ["a traversal", ASSETS_REF, `prs/7/../../.github/${"a".repeat(64)}.png`],
        ["a non-png name", ASSETS_REF, "prs/7/evil.sh"],
      ];
      for (const [name, ref, p] of bad) await expect(gh.publishAssets({ ref, files: [file(p)], message: "m" }), name).rejects.toThrow("publishAssets");
      expect(calls).toEqual([]);

      expect(await gh.publishAssets({ ref: ASSETS_REF, files: [file(ok)], message: "m" })).toEqual({ commitSha: "c".repeat(40) });
      expect(commitBody.parents).toEqual([]);
      expect(refBody.ref).toBe(ASSETS_REF);
    } finally {
      server.close();
    }
  });

  it("screenshots are re-encoded to at most 800 px wide, stripped, and embedded by a commit-pinned URL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-shots-"));
    try {
      const png = Buffer.concat([await sharp({ create: { width: 1280, height: 800, channels: 3, background: "#369" } }).png().toBuffer(), Buffer.from("<script>PAYLOAD</script>")]);
      let pushed: Array<{ path: string; bytes: Buffer }> = [];
      const github = { publishAssets: async (i: { files: typeof pushed }) => ((pushed = i.files), { commitSha: "d".repeat(40) }) };
      const links = await publishShots(github, "acme/app", dir, "prs", 9, [{ page: "/", png }]);
      expect((await sharp(pushed[0]!.bytes).metadata()).width).toBe(800);
      expect(pushed[0]!.bytes.includes("PAYLOAD")).toBe(false);
      expect(links).toEqual([{ page: "/", url: `https://github.com/acme/app/blob/${"d".repeat(40)}/prs/9/${sha(pushed[0]!.bytes)}.png?raw=true` }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
