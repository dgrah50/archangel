import { describe, expect, it, vi, afterEach } from "vitest";
import { ESCALATION_POLICY, MAIN_ESCALATION_POLICY, describeEscalation } from "../src/core/escalations.js";
import { collectOwnerReply } from "../src/core/owner-reply.js";
import { TelegramNotifier } from "../src/core/notifier.js";
import { renderRecapComment } from "../src/core/recap.js";
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
    workflowSha256: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("Needs You decision classes", () => {
  // The factory must never escalate into an irreversible action on its own: that class stays unused.
  it("keeps the irreversible class unused by every escalation source", () => {
    const classes = Object.values({ ...ESCALATION_POLICY, ...MAIN_ESCALATION_POLICY }).map((p) => p.decisionClass);
    expect(classes).not.toContain("irreversible");
  });

  it("feature escalations say the owner merges; bugfix text is unchanged", () => {
    expect(describeEscalation("gate_failed", "feature").recommendation).toContain("the owner merges it.");
    expect(describeEscalation("gate_failed").recommendation).not.toContain("owner merges it");
    const prompt = buildImplementPrompt({ issueNumber: 1, title: "t", body: "b", repoName: "a/b", workClass: "feature" });
    expect(prompt).toContain("NOT A BUG FIX");
    expect(prompt).not.toContain("reproduces the bug");
    expect(buildImplementPrompt({ issueNumber: 1, title: "t", body: "b", repoName: "a/b" })).toContain("reproduces the bug");
  });

  it("lists the owner comment commands in every escalation recommendation", () => {
    for (const code of Object.keys(ESCALATION_POLICY) as EscalationCode[]) {
      const r = describeEscalation(code).recommendation;
      expect(r).toContain("`/archangel retry`");
      expect(r).toContain("`/archangel close`");
      expect(r).toContain("`/archangel handoff`");
    }
  });

  it("shows class and recommendation in the Recap", () => {
    const body = renderRecapComment({ thread: needsYouThread("review_vetoed"), reviews: [], blockers: [] });
    expect(body).toContain("Needs You — live infrastructure");
    expect(body).toContain(`**Recommended:** ${describeEscalation("review_vetoed").recommendation}`);
  });
});

describe("Telegram Needs You message", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("includes decision class and recommendation", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await new TelegramNotifier({ botToken: "t", chatId: "c" }).notifyNeedsYou({
      issueNumber: 7,
      title: "Example",
      reason: "because",
      decisionClass: "spending",
      recommendation: "Retry to grant a fresh budget.",
    });
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.text).toContain("Decision: spending");
    expect(sent.text).toContain("Recommended: Retry to grant a fresh budget.");
  });
});

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

describe("owner code-quality rules", () => {
  it("reach implement and revision prompts", async () => {
    const { buildOpenAiReviewerPrompt, buildGeminiAdversarialPrompt } = await import("../src/agents/prompts.js");
    const impl = buildImplementPrompt({ issueNumber: 1, title: "t", body: "b", repoName: "a/b" });
    const rev = buildRevisionPrompt({ issueNumber: 1, title: "t", body: "b", gateViolations: [], structuredFindings: [] });
    for (const p of [impl, rev]) {
      expect(p).toContain("No fallbacks, compatibility shims");
      expect(p).toContain("single caller");
      expect(p).toContain("make the state explicit");
    }
    const base = { issueNumber: 1, title: "t", body: "b", diffText: "d" };
    for (const p of [
      buildOpenAiReviewerPrompt(base),
      buildGeminiAdversarialPrompt({ ...base, touchedFiles: {} }),
    ]) {
      expect(p).toContain("added fallback");
      expect(p).toContain("do not veto solely for them");
    }
  });
});
