import { describe, expect, it } from "bun:test";
import { renderRecapComment } from "../src/core/recap.js";
import type { ThreadRecord } from "../src/ledger/schema.js";

const thread: ThreadRecord = {
  issueNumber: 1,
  repo: "acme/app",
  title: "Example",
  themeLabel: null,
  bodySha256: "x",
  phase: { kind: "needs_you", code: "gate_failed", reason: "r", resumeTo: { kind: "queued" } },
  state: "needs_you",
  version: 1,
  mode: "autonomous",
  branchName: "factory/1",
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

describe("Recap triage secret scanning", () => {
  it("withholds credentials from an escalation reason and guidance steps", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const hits: string[] = [];
    const base = { thread, reviews: [], blockers: [], onWithheld: (pattern: string) => hits.push(pattern) };
    const escalation = renderRecapComment({
      ...base,
      triage: { vendor: "claude", action: "escalate", cause: "other", steps: [], reason: `use token ${token}` },
    });
    const guidance = renderRecapComment({
      ...base,
      triage: { vendor: "claude", action: "guidance", cause: "other", steps: [`use token ${token}`], reason: null },
    });

    expect(escalation).not.toContain(token);
    expect(guidance).not.toContain(token);
    expect(escalation).toContain("_Withheld: possible secret (github_token)");
    expect(guidance).toContain("_Withheld: possible secret (github_token)");
    expect(hits).toEqual(["github_token", "github_token"]);
  });
});
