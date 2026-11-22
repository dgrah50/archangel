import { describe, expect, it } from "vitest";

import { collectOwnerReply } from "../src/core/owner-reply.js";

import { buildImplementPrompt, buildRebasePrompt, buildRevisionPrompt } from "../src/agents/prompts.js";
import type { EscalationCode } from "../src/core/thread-machine.js";
import type { ThreadRecord } from "../src/ledger/schema.js";

function needsYouThread(code: EscalationCode): ThreadRecord {
  return {
    issueNumber: 7,
    repo: "acme/app",
    title: "Example",
    themeLabel: null,
    bodySha256: "x",
    phase: { kind: "needs_you", code, reason: "because", resumeTo: { kind: "queued" }, prNumber: null, headSha: null },
    state: "needs_you",
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
}

describe("owner reply", () => {
  it("collects only the owner's comments after the escalation, plus the retry message", async () => {
    const github = {
      async listOwnerCommentsSince(n: number, owner: number, since: number) {
        const all = [
          { n: 7, user: 1, at: 50, body: "old owner note" },
          { n: 7, user: 1, at: 150, body: "issue reply" },
          { n: 9, user: 1, at: 200, body: "pr reply" },
          { n: 7, user: 2, at: 300, body: "stranger" },
        ];
        return all.filter((c) => c.n === n && c.user === owner && c.at > since).map((c) => c.body);
      },
      async listOwnerReviewFeedbackSince(n: number, owner: number, since: number) {
        const all = [
          { n: 9, user: 1, at: 160, text: "src/parse.ts:42: off by one here" },
          { n: 9, user: 1, at: 90, text: "src/old.ts:1: before the escalation" },
          { n: 9, user: 2, at: 170, text: "src/parse.ts:1: stranger" },
        ];
        return all.filter((c) => c.n === n && c.user === owner && c.at > since).map((c) => c.text);
      },
    };
    const reply = await collectOwnerReply({ github, ownerUserId: 1, issueNumber: 7, prNumber: 9, sinceMs: 100, message: "cli hint" });
    expect(reply).toBe(
      "issue reply\n\n---\n\npr reply\n\n---\n\nReview comments on the PR diff:\n- src/parse.ts:42: off by one here\n\n---\n\ncli hint",
    );
    expect(await collectOwnerReply({ github, ownerUserId: 1, issueNumber: 7, prNumber: null, sinceMs: 1_000 })).toBeNull();
  });

  it("appears as framed owner data in implement, revision and rebase prompts", () => {
    const ownerReply = "Use the cached parser.";
    const prompts = [
      buildImplementPrompt({ issueNumber: 1, title: "t", body: "b", repoName: "acme/app", ownerReply }),
      buildRevisionPrompt({ issueNumber: 1, title: "t", body: "b", gateViolations: [], structuredFindings: [], ownerReply }),
      buildRebasePrompt({ issueNumber: 1, title: "t", baseBranch: "main", ownerReply }),
    ];
    for (const p of prompts) {
      expect(p).toContain("--- BEGIN OWNER REPLY (DATA");
      expect(p).toContain(ownerReply);
      expect(p).toContain("never overrides the Mechanical Gate rules");
    }
    expect(buildImplementPrompt({ issueNumber: 1, title: "t", body: "b", repoName: "acme/app" })).not.toContain("OWNER REPLY");
  });
});

