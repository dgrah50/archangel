import { describe, expect, it } from "vitest";
import {
  buildGeminiAdversarialPrompt,
  buildImplementPrompt,
  buildOpenAiReviewerPrompt,
  buildRevisionPrompt,
} from "../src/agents/prompts.js";
import { buildDigest, sendDigestIfDue } from "../src/core/digest.js";
import { UNAVAILABLE, buildMetricsBlock, buildMetricsBlockFrom } from "../src/core/metrics-block.js";
import { extractAssumptions, renderRecapComment } from "../src/core/recap.js";
import { resolveSkills } from "../src/core/skills.js";
import type { ThreadRecord } from "../src/ledger/schema.js";
import { Ledger } from "../src/ledger/store.js";

const reviewerInput = { issueNumber: 1, title: "t", body: "b", diffText: "d" };

describe("reviewer prompts", () => {
  it("both ask for the expected fix before the diff and for sibling-path checks", () => {
    for (const p of [
      buildOpenAiReviewerPrompt(reviewerInput),
      buildGeminiAdversarialPrompt({ ...reviewerInput, touchedFiles: {} }),
    ]) {
      expect(p).toContain("Before reading the diff, state in one line what fix you would expect for this issue");
      expect(p).toContain("Check sibling code paths and callers of the changed code for the same defect.");
      expect(p.indexOf("Before reading the diff")).toBeLessThan(p.indexOf("BEGIN UNIFIED DIFF DATA"));
    }
  });
});

describe("implementer prompts", () => {
  const impl = { issueNumber: 1, title: "t", body: "b", repoName: "o/r" };
  const rev = { issueNumber: 1, title: "t", body: "b", gateViolations: [], structuredFindings: [] };
  it("require local docs and types before API use, with no web lookups", () => {
    for (const p of [buildImplementPrompt(impl), buildImplementPrompt({ ...impl, workClass: "feature" }), buildRevisionPrompt(rev)]) {
      expect(p).toContain("read the repository's local docs and type definitions");
      expect(p).toContain("Do not look anything up on the web");
    }
  });
  it("require an Assumptions: heading in the final summary", () => {
    for (const p of [buildImplementPrompt(impl), buildImplementPrompt({ ...impl, workClass: "feature" }), buildRevisionPrompt(rev)]) {
      expect(p).toContain("`Assumptions:` heading");
    }
  });
});

describe("recurrence skill", () => {
  it("resolves through resolveSkills and demands a boundary test that fails on main", () => {
    const [skill] = resolveSkills(["general/recurrence"]);
    expect(skill!.ref).toBe("general/recurrence");
    expect(skill!.content).toContain("fails today");
    expect(skill!.content).toContain("sibling");
  });
});

const thread: ThreadRecord = {
  issueNumber: 7, repo: "acme/app", title: "Example", themeLabel: null, bodySha256: "x",
  phase: { kind: "awaiting_gate", prNumber: 10, headSha: "abcdef1234567890", baseSha: "b1", since: 0, nudgedAt: null },
  state: "awaiting_gate", version: 1, mode: "autonomous", branchName: "factory/7", lastSummary: null,
  implementCount: 1, revisionCount: 0, rebaseCount: 0, implementerVendors: [], ownerReply: null, retryGrants: 0, factoryRetries: 0, factoryGuidance: null,
  workflowSha256: null, createdAt: 0, updatedAt: 0,
};
const recap = (summary: string | null) => renderRecapComment({ thread, reviews: [], blockers: [], summary });

describe("Recap assumptions", () => {
  it("shows the Assumptions list as plain fenced text", () => {
    const body = recap("Fixed the slice bound.\n\nAssumptions:\n- input is UTF-8\n- <script>alert(1)</script> stays text\n");
    expect(body).toContain("#### Implementer Assumptions");
    expect(body).toContain("```text\n- input is UTF-8\n- <script>alert(1)</script> stays text\n```");
  });
  it("says none stated when the heading is missing or empty, and shows nothing without a summary", () => {
    expect(recap("Fixed it.")).toContain("_none stated_");
    expect(recap("Fixed it.\nAssumptions: none")).toContain("_none stated_");
    expect(recap(null)).not.toContain("Implementer Assumptions");
  });
  it("stops at the next heading and handles an inline first item", () => {
    expect(extractAssumptions("Assumptions: only one\n\n## Next\nx")).toBe("only one");
    expect(extractAssumptions("Assumptions:\n- a\n- b\n## Tests\n- t")).toBe("- a\n- b");
  });
});

describe("unavailable is not empty: metrics block", () => {
  it("renders every figure as unavailable when the source fails, distinct from a real zero", () => {
    const failed = buildMetricsBlockFrom(() => {
      throw new Error("db locked");
    });
    expect(failed).toContain(`threads_total: ${UNAVAILABLE}`);
    expect(failed).toContain(`outcomes: ${UNAVAILABLE}`);
    expect(failed).toContain(`  - ${UNAVAILABLE}`);
    expect(failed).not.toContain("none");
    expect(buildMetricsBlock(null)).toBe(failed);

    const l = new Ledger(":memory:", { repo: "a/b" });
    const real = buildMetricsBlock(l.computeMetrics({ repo: "a/b", now: 1 }));
    expect(real).toContain("threads_total: 0");
    expect(real).toContain("escalations_by_code: none");
    expect(real).not.toContain(UNAVAILABLE);
    l.close();
  });
});

describe("unavailable is not empty: digest", () => {
  const known = { needsYou: [], proposals: [], pitches: [], now: 0 };
  it("a known zero stays quiet, an unavailable figure is shown and keeps the digest alive", () => {
    expect(buildDigest({ ...known, yesterday: { autonomousMerges: 0, ownerMerges: 0, reverts: 0, spendUsd: 0 } })).toBeNull();
    const text = buildDigest({ ...known, yesterday: { autonomousMerges: 0, ownerMerges: null, reverts: 0, spendUsd: null } })!;
    expect(text).toContain("Merges: 0 autonomous, unavailable owner");
    expect(text).toContain("Reverts (red main): 0");
    expect(text).toContain("Metered spend: unavailable");
  });
  it("an unreadable Needs You list is unavailable, not empty", () => {
    const text = buildDigest({ ...known, needsYou: null, yesterday: { autonomousMerges: 0, ownerMerges: 0, reverts: 0, spendUsd: 0 } })!;
    expect(text).toContain("Needs You: unavailable");
  });
  it("a failed ledger query makes that figure null; a failed GitHub read makes proposals unavailable", async () => {
    const l = new Ledger(":memory:", { repo: "a/b", timeZone: "UTC" });
    (l as unknown as { db: { exec(s: string): void } }).db.exec("DROP TABLE daily_spend");
    const input = l.collectDigestInput(Date.UTC(2026, 2, 10, 14));
    expect(input.yesterday.spendUsd).toBeNull();
    expect(input.yesterday.autonomousMerges).toBe(0);

    const sent: string[] = [];
    await sendDigestIfDue(
      l,
      { sendDigest: async (t) => void sent.push(t) },
      {
        now: Date.UTC(2026, 2, 10, 14),
        timeZone: "UTC",
        digestHour: 9,
        openProposals: async () => {
          throw new Error("github down");
        },
      },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Metered spend: unavailable");
    expect(sent[0]).toContain("Scout proposals awaiting you: unavailable");
    l.close();
  });
});
