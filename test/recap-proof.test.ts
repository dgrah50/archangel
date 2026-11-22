import crypto from "node:crypto";
import http from "node:http";
import { describe, expect, it } from "bun:test";
import { renderRecapComment } from "../src/core/recap.js";
import { PROOF_MAX_CHARS, PROOF_MAX_LINES, runGateForActions, tailOutput, type GateReport } from "../src/gate/gate.js";
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
  retryGrants: 0,
  factoryRetries: 0,
  factoryGuidance: null,
  factoryTriage: null,
  workflowSha256: null,
  createdAt: 0,
  updatedAt: 0,
};
const render = (gateProof?: Parameters<typeof renderRecapComment>[0]["gateProof"]) =>
  renderRecapComment({ thread, reviews: [], blockers: [], gateProof });

describe("Recap proof output is untrusted", () => {
  it("strips ANSI and control characters and withholds output that matches the secret scan", () => {
    const out = render({ base_output: "\x1b[31mFAIL\x1b[0m expected 1\x07\r\n", head_output: `token ghp_${"a".repeat(30)}` });
    expect(out).toContain("FAIL expected 1");
    expect(out).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(out).toContain("output withheld");
    expect(out).not.toContain("ghp_");
  });
});

describe("GitHubAppClient.getGateProof", () => {
  it("reads the Gate annotation for the matching head SHA and ignores stale or malformed ones", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    let message = JSON.stringify({ head_sha: "sha1", base_output: "red", head_output: "green" });
    let annotations: Array<{ title: string; message: string }> = [];
    const server = http.createServer((req, res) => {
      res.writeHead(req.method === "POST" ? 201 : 200, { "Content-Type": "application/json" });
      if (req.method === "POST") {
        res.end(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { checks: "read" } }));
      } else {
        res.end(JSON.stringify(annotations));
      }
    });
    annotations = [{ title: "other", message: "x" }, { title: "archangel-gate-proof", message }];
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
      // Two proof annotations (e.g. one forged by repo code) are ambiguous: not captured.
      annotations = [{ title: "archangel-gate-proof", message }, { title: "archangel-gate-proof", message }];
      expect(await client.getGateProof(5, "sha1")).toBeNull();
      message = "not json";
      annotations = [{ title: "other", message: "x" }, { title: "archangel-gate-proof", message }];
      expect(await client.getGateProof(5, "sha1")).toBeNull();
    } finally {
      server.close();
    }
  });
});

const PR_HEAD = "39fed38e".padEnd(40, "0");
const MERGE_COMMIT = "d286d3e8".padEnd(40, "0");

describe("runGateForActions", () => {
  it("puts the PR head in the proof even though the Gate ran on a merge commit, and emits no proof without a valid head SHA", async () => {
    const report = { passed: true, head_sha: MERGE_COMMIT, proof: { base_output: "red", head_output: "green" } } as unknown as GateReport;
    const emit = async (sha?: string) => {
      const log: string[] = [];
      await runGateForActions({} as never, (l) => log.push(l), async () => report, "tok", sha);
      return log.filter((l) => l.startsWith("::notice title=archangel-gate-proof::"));
    };
    const [notice] = await emit(PR_HEAD);
    const body = JSON.parse(decodeURIComponent(notice!.replace("::notice title=archangel-gate-proof::", "")));
    expect(body.head_sha).toBe(PR_HEAD);
    expect(body.head_sha).not.toBe(MERGE_COMMIT);
    expect(await emit(undefined)).toEqual([]);
    expect(await emit("not-a-sha")).toEqual([]);
    expect(await emit(MERGE_COMMIT.toUpperCase())).toEqual([]);
  });

});
