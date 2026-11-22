import crypto from "node:crypto";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { renderRecapComment } from "../src/core/recap.js";
import { PROOF_MAX_CHARS, PROOF_MAX_LINES, tailOutput } from "../src/gate/gate.js";
import { GitHubAppClient } from "../src/github/client.js";
import type { ThreadRecord } from "../src/ledger/schema.js";

const thread: ThreadRecord = {
  issueNumber: 7,
  repo: "acme/app",
  title: "Example",
  themeLabel: null,
  bodySha256: "x",
  phase: { kind: "awaiting_gate", prNumber: 10, headSha: "abcdef1234567890", baseSha: "b1", since: 0, nudgedAt: null },
  state: "awaiting_gate",
  version: 1,
  mode: "autonomous",
  branchName: "factory/7",
  lastSummary: null,
  implementCount: 1,
  revisionCount: 0,
  rebaseCount: 0,
  implementerVendors: [],
  ownerReply: null,
  createdAt: 0,
  updatedAt: 0,
};
const render = (gateProof?: Parameters<typeof renderRecapComment>[0]["gateProof"]) =>
  renderRecapComment({ thread, reviews: [], blockers: [], gateProof });

describe("Recap reproduction-test proof", () => {
  it("shows base (failing) and head (passing) output in labelled fenced blocks", () => {
    const body = render({ base_output: "FAIL add: expected -3 got 7", head_output: "ok add" });
    expect(body).toContain("Machine output");
    expect(body).toContain("**On base (expected to fail):**\n```text\nFAIL add: expected -3 got 7\n```");
    expect(body).toContain("**On head (expected to pass):**\n```text\nok add\n```");
    expect(body).not.toContain("not captured");
  });

  it("says 'not captured' explicitly for missing output, per side", () => {
    expect(render()).toContain("**On base (expected to fail):**\n_not captured_");
    expect(render()).toContain("**On head (expected to pass):**\n_not captured_");
    const half = render({ base_output: "boom" });
    expect(half).toContain("```text\nboom\n```");
    expect(half).toMatch(/On head \(expected to pass\):\*\*\n_not captured_/);
  });

  it("trims to the last lines/chars and cannot be broken out of by backticks in the output", () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const t = tailOutput(long);
    expect(t.split("\n").length).toBeLessThanOrEqual(PROOF_MAX_LINES);
    expect(t.endsWith("line 199")).toBe(true);
    expect(tailOutput("x".repeat(10_000)).length).toBe(PROOF_MAX_CHARS);

    const body = render({ base_output: "```\n# injected heading", head_output: "ok" });
    expect(body).toContain("````text\n```\n# injected heading\n````");
  });
});

describe("GitHubAppClient.getGateProof", () => {
  it("reads the Gate annotation for the matching head SHA and ignores stale or malformed ones", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    let message = JSON.stringify({ head_sha: "sha1", base_output: "red", head_output: "green" });
    const server = http.createServer((req, res) => {
      res.writeHead(req.method === "POST" ? 201 : 200, { "Content-Type": "application/json" });
      if (req.method === "POST") {
        res.end(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { checks: "read" } }));
      } else {
        res.end(JSON.stringify([{ title: "other", message: "x" }, { title: "archangel-gate-proof", message }]));
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
      expect(await client.getGateProof(5, "sha1")).toEqual({ base_output: "red", head_output: "green" });
      expect(await client.getGateProof(5, "sha2")).toBeNull();
      message = "not json";
      expect(await client.getGateProof(5, "sha1")).toBeNull();
    } finally {
      server.close();
    }
  });
});
