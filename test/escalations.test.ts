import { describe, expect, it, vi, afterEach } from "vitest";
import { DECISION_CLASSES, ESCALATION_POLICY, MAIN_ESCALATION_POLICY, describeEscalation } from "../src/core/escalations.js";
import { collectOwnerReply } from "../src/core/owner-reply.js";
import { TelegramNotifier } from "../src/core/notifier.js";
import { renderRecapComment } from "../src/core/recap.js";
import { buildImplementPrompt, buildRebasePrompt, buildRevisionPrompt } from "../src/agents/prompts.js";
import { EscalationCodeSchema, type EscalationCode } from "../src/core/thread-machine.js";
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
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("Needs You decision classes", () => {
  it("maps every escalation code to a known class with a recommendation", () => {
    for (const code of EscalationCodeSchema.options) {
      const p = describeEscalation(code);
      expect(DECISION_CLASSES).toContain(p.decisionClass);
      expect(p.recommendation.length).toBeGreaterThan(20);
    }
    expect(Object.keys(ESCALATION_POLICY).sort()).toEqual([...EscalationCodeSchema.options].sort());
  });

  // One test per class: each class the factory can raise has at least one concrete source.
  const sources: Record<string, string[]> = {};
  for (const [code, p] of Object.entries({ ...ESCALATION_POLICY, ...MAIN_ESCALATION_POLICY })) {
    (sources[p.decisionClass] ??= []).push(code);
  }
  for (const cls of DECISION_CLASSES) {
    it(`class ${cls} has a defined source or is reserved for explicit owner sign-off`, () => {
      if (cls === "irreversible") {
        // Archangel never takes irreversible actions itself; nothing may escalate into it silently.
        expect(sources[cls] ?? []).toEqual([]);
      } else {
        expect((sources[cls] ?? []).length).toBeGreaterThan(0);
      }
    });
  }

  it("feature escalations say the owner merges; bugfix text is unchanged", () => {
    expect(describeEscalation("gate_failed", "feature").recommendation).toMatch(/owner merges it\.$/);
    expect(describeEscalation("gate_failed").recommendation).toBe(ESCALATION_POLICY.gate_failed.recommendation);
    const prompt = buildImplementPrompt({ issueNumber: 1, title: "t", body: "b", repoName: "a/b", workClass: "feature" });
    expect(prompt).toContain("NOT A BUG FIX");
    expect(prompt).not.toContain("reproduces the bug");
    expect(buildImplementPrompt({ issueNumber: 1, title: "t", body: "b", repoName: "a/b" })).toContain("reproduces the bug");
  });

  it("shows class and recommendation in the Recap", () => {
    const body = renderRecapComment({ thread: needsYouThread("review_vetoed"), reviews: [], blockers: [] });
    expect(body).toContain("Needs You — live infrastructure");
    expect(body).toContain(`**Recommended:** ${ESCALATION_POLICY.review_vetoed.recommendation}`);
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
