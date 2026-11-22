import crypto from "node:crypto";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { GitHubAppClient } from "../src/github/client.js";
import { RECAP_MARKER } from "../src/core/recap.js";

function generateTestRsaKey(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

describe("GitHubAppClient (JWT, pagination, ETag 304, check-run dedupe)", () => {
  it("mints RS256 installation tokens, paginates Link headers, reuses ETag 304, deduplicates check runs, and upserts recap", async () => {
    const privateKeyPem = generateTestRsaKey();
    let issueHits = 0;
    let patchedCommentId: number | null = null;
    let mergePayload: Record<string, unknown> | null = null;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "POST" && url.pathname === "/app/installations/777/access_tokens") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token: "ghs_test_token",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: {
              contents: "write",
              pull_requests: "write",
              issues: "write",
              checks: "read",
            },
          }),
        );
        return;
      }

      // Paginated issues with ETag on page 1
      if (req.method === "GET" && url.pathname === "/repos/acme/app/issues") {
        const page = url.searchParams.get("page") ?? "1";
        if (page === "1") {
          issueHits++;
          if (req.headers["if-none-match"] === '"etag-p1"') {
            res.writeHead(304);
            res.end();
            return;
          }
          const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
          res.writeHead(200, {
            "Content-Type": "application/json",
            ETag: '"etag-p1"',
            Link: `<${baseUrl}/repos/acme/app/issues?page=2>; rel="next"`,
          });
          res.end(
            JSON.stringify([
              { number: 1, title: "p1", body: "b1", state: "open", user: { id: 9, login: "dgrah50" }, author_association: "OWNER", labels: [{ name: "ready-for-agent" }], updated_at: "2026-11-21T00:00:00Z" },
            ]),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            { number: 2, title: "p2", body: "b2", state: "open", user: { id: 9, login: "dgrah50" }, author_association: "OWNER", labels: [{ name: "ready-for-agent" }], updated_at: "2026-11-21T00:00:00Z" },
          ]),
        );
        return;
      }

      // Check runs with duplicate names -> must keep highest id
      if (req.method === "GET" && url.pathname === "/repos/acme/app/commits/abc123/check-runs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            check_runs: [
              { id: 10, name: "Gate", status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
              { id: 25, name: "Gate", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
            ],
          }),
        );
        return;
      }

      // Recap comments upsert -> PATCH existing
      if (req.method === "GET" && url.pathname === "/repos/acme/app/issues/5/comments") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ id: 501, body: `${RECAP_MARKER}\nold recap` }]));
        return;
      }
      if (req.method === "PATCH" && url.pathname === "/repos/acme/app/issues/comments/501") {
        patchedCommentId = 501;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: 501 }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/repos/acme/app/pulls/5") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ number: 5, head: { ref: "agent/issue-5", sha: "head555" } }));
        return;
      }

      // Squash merge pinned to SHA
      if (req.method === "PUT" && url.pathname === "/repos/acme/app/pulls/5/merge") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          mergePayload = JSON.parse(body) as Record<string, unknown>;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ merged: true, sha: "sq999" }));
        });
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    try {
      const gh = new GitHubAppClient({
        owner: "acme",
        repo: "app",
        appId: "123",
        installationId: 777,
        privateKeyPem,
        apiBaseUrl: `http://127.0.0.1:${port}`,
      });

      const meta = await gh.mintInstallationTokenWithMeta();
      expect(meta.permissions.contents).toBe("write");
      expect(meta.permissions.workflows).toBeUndefined();

      // Multi-page fetch + ETag 304 reuse on second call
      const issues1 = await gh.listOpenIssuesByLabel("ready-for-agent");
      const issues2 = await gh.listOpenIssuesByLabel("ready-for-agent");
      expect(issues1.map((i) => i.number)).toEqual([1, 2]);
      expect(issues2.map((i) => i.number)).toEqual([1, 2]);
      expect(issueHits).toBe(2);

      // Deduplicated check runs -> highest id (25, success)
      const checks = await gh.getCheckRunsForRef("abc123");
      expect(checks).toHaveLength(1);
      expect(checks[0]?.id).toBe(25);
      expect(checks[0]?.conclusion).toBe("success");

      // Upsert recap patches existing comment 501
      await gh.upsertRecapComment(5, `${RECAP_MARKER}\nnew recap`);
      expect(patchedCommentId).toBe(501);

      // Squash merge pins exact head SHA
      const merged = await gh.squashMergePr(5, "head555", "fix(#5)");
      expect(merged.squashSha).toBe("sq999");
      expect(mergePayload).toMatchObject({ sha: "head555", merge_method: "squash" });
    } finally {
      server.close();
    }
  });
});

describe("GitHubAppClient.verifyLabelRemovedBy", () => {
  it("is true only when the most recent unlabeled event for that label was made by the expected user", async () => {
    const timeline: Array<Record<string, unknown>> = [
      { event: "labeled", label: { name: "needs-you" }, actor: { id: 1 } },
      { event: "unlabeled", label: { name: "needs-you" }, actor: { id: 999 } },
      { event: "labeled", label: { name: "needs-you" }, actor: { id: 1 } },
      { event: "unlabeled", label: { name: "other" }, actor: { id: 5 } },
    ];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.writeHead(url.pathname.endsWith("/access_tokens") ? 201 : 200, { "Content-Type": "application/json" });
      if (url.pathname.endsWith("/access_tokens")) {
        res.end(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { issues: "write" } }));
      } else {
        res.end(JSON.stringify(timeline));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const client = new GitHubAppClient({
        owner: "acme", repo: "app", appId: "1", installationId: 777, privateKeyPem: generateTestRsaKey(),
        apiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      });
      expect(await client.verifyLabelRemovedBy(4, "needs-you", 999)).toBe(true);
      expect(await client.verifyLabelRemovedBy(4, "needs-you", 1)).toBe(false);
      expect(await client.verifyLabelRemovedBy(4, "never-removed", 999)).toBe(false);
      timeline.push({ event: "unlabeled", label: { name: "needs-you" }, actor: { id: 555 } }); // a later removal by someone else wins
      expect(await client.verifyLabelRemovedBy(4, "needs-you", 999)).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe("GitHubAppClient file reads: only a real 404 is 'missing'", () => {
  async function client(handler: (path: string) => { status: number; body: unknown }) {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname.endsWith("/access_tokens")) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: "read" } }));
        return;
      }
      const { status, body } = handler(url.pathname);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const c = new GitHubAppClient({
      owner: "acme", repo: "app", appId: "1", installationId: 777, privateKeyPem: generateTestRsaKey(),
      apiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    return { c, close: () => server.close() };
  }

  it("a 500 whose body happens to say (404) is an error, not a missing file", async () => {
    const t = await client(() => ({ status: 500, body: "upstream said (404) somewhere" }));
    try {
      await expect(t.c.fileExistsAtRef("main", "a.txt")).rejects.toThrow();
      await expect(t.c.readFileAtRef("main", "a.txt")).rejects.toThrow();
    } finally {
      t.close();
    }
  });

});

describe("GitHubAppClient.squashMergePr refuses machine drafts", () => {
  it("throws before the PUT /merge when the head ref starts with agent-draft/", async () => {
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname.endsWith("/access_tokens")) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { pull_requests: "write" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.method === "GET") res.end(JSON.stringify({ number: 7, head: { ref: "agent-draft/prefer-small-7-1", sha: "h7" } }));
      else res.end(JSON.stringify({ merged: true, sha: "sq7" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const gh = new GitHubAppClient({
        owner: "acme",
        repo: "app",
        appId: "123",
        installationId: 777,
        privateKeyPem: generateTestRsaKey(),
        apiBaseUrl: `http://127.0.0.1:${port}`,
      });
      await expect(gh.squashMergePr(7, "h7", "draft")).rejects.toThrow(/agent-draft\/.*owner/);
      expect(calls).toContain("GET /repos/acme/app/pulls/7");
      expect(calls.some((c) => c.startsWith("PUT "))).toBe(false);
    } finally {
      server.close();
    }
  });
});
