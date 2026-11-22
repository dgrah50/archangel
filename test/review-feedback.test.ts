import crypto from "node:crypto";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { GitHubAppClient } from "../src/github/client.js";

describe("GitHubAppClient.listOwnerReviewFeedbackSince", () => {
  it("returns the owner's inline diff comments and review summaries after the cutoff, oldest first", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const at = (ms: number) => new Date(ms).toISOString();
    const server = http.createServer((req, res) => {
      res.writeHead(req.method === "POST" ? 201 : 200, { "Content-Type": "application/json" });
      if (req.method === "POST") {
        res.end(JSON.stringify({ token: "t", expires_at: at(Date.now() + 3600_000), permissions: {} }));
      } else if (req.url?.includes("/pulls/5/comments")) {
        res.end(
          JSON.stringify([
            { body: "off by one", path: "src/a.ts", line: 42, created_at: at(3_000), user: { id: 1 } },
            { body: "old", path: "src/a.ts", line: 1, created_at: at(500), user: { id: 1 } },
            { body: "stranger", path: "src/a.ts", line: 2, created_at: at(4_000), user: { id: 2 } },
            { body: "outdated line", path: "src/b.ts", line: null, original_line: 7, created_at: at(2_500), user: { id: 1 } },
          ]),
        );
      } else if (req.url?.includes("/pulls/5/reviews")) {
        res.end(
          JSON.stringify([
            { body: "Please handle empty input", state: "CHANGES_REQUESTED", submitted_at: at(2_000), user: { id: 1 } },
            { body: "", state: "COMMENTED", submitted_at: at(5_000), user: { id: 1 } },
            { body: "lgtm", state: "APPROVED", submitted_at: at(6_000), user: { id: 2 } },
          ]),
        );
      } else {
        res.end("[]");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const client = new GitHubAppClient({
        owner: "acme",
        repo: "app",
        appId: "1",
        installationId: 2,
        privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
        apiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      });
      expect(await client.listOwnerReviewFeedbackSince(5, 1, 1_000)).toEqual([
        "Review (changes requested): Please handle empty input",
        "src/b.ts:7: outdated line",
        "src/a.ts:42: off by one",
      ]);
    } finally {
      server.close();
    }
  });
});
