import crypto from "node:crypto";
import http from "node:http";
import { describe, expect, it } from "bun:test";
import { renderPrBody, renderRecapComment } from "../src/core/recap.js";
import { buildChapters, parseDiffStat } from "../src/core/recap-chapters.js";
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

describe("Recap agent text", () => {
  it("withholds a secret in the implementer summary and a reviewer finding, keeping the rest of the comment", () => {
    const token = `ghp_${"a".repeat(30)}`;
    const reviews = [{ vendor: "claude", headSha: "abcdef123456", verdict: "block", findingsJson: JSON.stringify([{ severity: "high", file: "a.ts", summary: `leaks ${token}` }]) }] as never;
    const hits: string[] = [];
    const out = renderRecapComment({ thread: { ...thread, lastSummary: `done, key is ${token}\nAssumptions: none` }, reviews, blockers: [], onWithheld: (p) => hits.push(p) });
    expect(out).not.toContain("ghp_");
    expect(out).toContain("_Withheld: possible secret (github_token)");
    expect(out).toContain("Reproduction Test Proof");
    expect(hits).toEqual(["github_token", "github_token"]);
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

  it("emits a proof for a failed run that stays whole JSON under GitHub's 4,096-character annotation cap (gijq#8)", async () => {
    const noisy = (c: string) => Array.from({ length: 40 }, (_, i) => `    --- FAIL: ${c}${i} "quoted" \\ café`).join("\n").slice(-3000);
    const report = { passed: false, proof: { base_output: noisy("a"), head_output: noisy("b") } } as unknown as GateReport;
    const log: string[] = [];
    await runGateForActions({} as never, (l) => log.push(l), async () => report, "tok", PR_HEAD);
    const notice = log.find((l) => l.startsWith("::notice title=archangel-gate-proof::"))!;
    const message = decodeURIComponent(notice.replace("::notice title=archangel-gate-proof::", ""));
    expect(message.length).toBeLessThan(4096);
    const body = JSON.parse(message);
    expect(body.head_sha).toBe(PR_HEAD);
    expect(body.head_output.endsWith("b39 \"quoted\" \\ café")).toBe(true);
  });

});

describe("Recap and PR body are scannable", () => {
  it("open with a short Summary, keep proof and reviews collapsed, and keep the trust labels", () => {
    const out = renderRecapComment({
      thread,
      reviews: [{ vendor: "codex", headSha: "abcdef1234567890", verdict: "approve", findingsJson: "[]" } as never],
      blockers: [],
      issueBody: "Login fails on empty password.\n\nMore detail.",
      chapters: [
        { area: "src", kind: "code", purpose: "p", files: [{ path: "src/a.ts", added: 9, deleted: 3 }], added: 9, deleted: 3 },
        { area: "test", kind: "test", purpose: "p", files: [{ path: "test/a.test.ts", added: 3, deleted: 0 }], added: 3, deleted: 0 },
      ],
      gateProof: { base_output: "red", head_output: "green" },
      triage: { vendor: "codex", action: "escalate", cause: "x", steps: [], reason: "why" },
    });
    const body = out.split("\n").slice(out.split("\n").indexOf("#### Summary"));
    const summary = body.slice(0, body.findIndex((l) => l === "<details>"));
    expect(summary.filter((l) => l.trim()).length).toBeLessThanOrEqual(12);
    for (const title of ["Gate proof and reproduction output", "Independent Reviews"]) {
      expect(out).toMatch(new RegExp(`<details>\\n<summary>${title}</summary>`));
    }
    expect(out).toContain("owner-written");
    expect(out).toContain("Machine triage (factory), not the owner");
    expect(out).toContain("not written by Archangel");
    expect(renderPrBody({ number: 7, title: "t", body: "b" }, []).startsWith("### Summary")).toBe(true);
  });

  it("state the real problem, the expected behaviour and what changed, in a bugfix Summary", () => {
    const issueBody = "Store.Add keeps whitespace variants as separate entries. Two problems follow:\n\n- blanks\n- padding\n\nExpected: trimmed queries dedupe. Blank queries are dropped.\n\nRepro:\n1. add ' a'";
    const chapters = buildChapters(
      parseDiffStat(
        [
          "diff --git a/internal/store.go b/internal/store.go",
          "@@ -1 +1,2 @@",
          "-old",
          "+new",
          "+more",
          "diff --git a/internal/store_regression_test.go b/internal/store_regression_test.go",
          "new file mode 100644",
          "@@ -0,0 +1 @@",
          "+t",
        ].join("\n"),
      ),
      { isProtected: () => false, isTest: (p) => p.endsWith("_test.go") },
    );
    const out = renderRecapComment({ thread: { ...thread, branchName: "archangel/issue-1" }, reviews: [], blockers: [], issueBody, chapters });
    expect(out).toContain("Store.Add keeps whitespace variants as separate entries.");
    expect(out).not.toContain("Two problems follow");
    expect(out).not.toContain("add ' a'");
    expect(out).toContain("**Expected** (issue #");
    expect(out).toContain("trimmed queries dedupe.");
    expect(out).toContain("**Now:** changes `internal/store.go` (+2/−1); new test `internal/store_regression_test.go`");
    expect(renderPrBody({ number: 1, title: "t", body: issueBody }, chapters)).toContain("**Now:** changes `internal/store.go`");
  });
});
