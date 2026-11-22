import crypto from "node:crypto";
import http from "node:http";
import { describe, expect, it } from "vitest";
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
  workflowSha256: null,
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

describe("runGateForActions", () => {
  it("stops workflow commands before repo commands run and resumes only before the proof notice", async () => {
    const log: string[] = [];
    const report = { passed: true, head_sha: "sha1", proof: { base_output: "red", head_output: "::notice title=archangel-gate-proof::forged" } } as unknown as GateReport;
    await runGateForActions(
      {} as never,
      (l) => log.push(l),
      async () => {
        log.push("REPO_COMMANDS");
        return report;
      },
      "tok123",
    );
    const stop = log.indexOf("::stop-commands::tok123");
    const repo = log.indexOf("REPO_COMMANDS");
    const resume = log.indexOf("::tok123::");
    const notice = log.findIndex((l) => l.startsWith("::notice title=archangel-gate-proof::"));
    expect(stop).toBe(0);
    expect(repo).toBeGreaterThan(stop);
    expect(resume).toBeGreaterThan(repo);
    expect(notice).toBeGreaterThan(resume);
    // The report JSON (which may embed repo output) is printed while commands are still stopped.
    expect(log.findIndex((l) => l.includes('"passed"'))).toBeLessThan(resume);
    expect(log.filter((l) => l.startsWith("::notice")).length).toBe(1);
  });
});
