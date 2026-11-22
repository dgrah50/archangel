import crypto from "node:crypto";
import http from "node:http";
import { describe, expect, it } from "bun:test";
import { GitHubAppClient } from "../src/github/client.js";

/** A server that accepts the connection and never answers. */
async function silentServer() {
  const server = http.createServer(() => {
    /* never respond */
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe("HTTP calls cannot hang the tick", () => {
  it("a GitHub request that never answers is aborted by the client's timeout", async () => {
    const { server, url } = await silentServer();
    try {
      const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const client = new GitHubAppClient({
        owner: "a", repo: "b", appId: "1", installationId: 2, apiBaseUrl: url, requestTimeoutMs: 300,
        privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
      });
      const started = Date.now();
      await expect(client.mintInstallationTokenWithMeta()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

});
