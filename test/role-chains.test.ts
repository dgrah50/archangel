import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";
import { ChainsSchema, HostYamlSchema, resolveRequiredReviewers } from "../src/config.js";
import { findReviewerIndependenceGaps } from "../src/core/doctor.js";

const host = (extra: Record<string, unknown> = {}) => ({ ownerUserId: 1, projects: [{ repo: "a/b" }], ...extra });

describe("host chains config", () => {
  it("rejects an empty implement, revise, rebase, scout or triage chain", () => {
    for (const role of ["implement", "revise", "rebase", "scout", "triage"]) {
      expect(() => HostYamlSchema.parse(host({ chains: { [role]: [] } })), role).toThrow(/at least one provider/);
    }
  });

});

function runner(chains: Parameters<typeof ChainsSchema.parse>[0]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-role-"));
  const calls: Array<{ provider: string; model?: string }> = [];
  const impl = new SubscriptionImplementer({
    chains: ChainsSchema.parse(chains),
    transcriptsDir: path.join(tmp, "t"),
    invoker: async ({ provider, model }) => {
      calls.push({ provider, model });
      return { code: 0, stdout: "{}", stderr: "", aborted: false };
    },
  });
  const run = (role: "implement" | "revise" | "rebase", extra: Record<string, unknown> = {}) =>
    impl.run({ issueNumber: 1, cloneDir: tmp, prompt: "p", abortController: new AbortController(), maxTurns: 1, timeoutMs: 1000, maxBudgetUsd: 1, role, ...extra });
  return { run, calls, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

describe("role routing per attempt kind", () => {
  const chains = {
    implement: [{ provider: "codex", model: "big" }],
    revise: [{ provider: "codex", model: "mini" }, { provider: "claude", model: "haiku" }],
    rebase: [{ provider: "agy", model: "flash" }],
  };

  it("implement, revise and rebase each use their own chain and model", async () => {
    const r = runner(chains);
    try {
      await r.run("implement");
      await r.run("revise");
      await r.run("rebase");
      expect(r.calls).toEqual([
        { provider: "codex", model: "big" },
        { provider: "codex", model: "mini" },
        { provider: "agy", model: "flash" },
      ]);
    } finally {
      r.cleanup();
    }
  });

});

describe("reviewer independence across the writing roles", () => {
  const reviewerChain = [{ provider: "agy" as const }, { provider: "claude" as const }, { provider: "codex" as const }];
  const chains = ChainsSchema.parse({
    implement: [{ provider: "codex", model: "big" }],
    revise: [{ provider: "claude", model: "haiku" }],
    rebase: [{ provider: "codex", model: "mini" }],
  });
  const cfg = { authMode: "subscription" as const, chains, reviewerChain };

  it("once Attempts record their vendors, only those vendors are excluded, so a model change never makes a vendor its own reviewer", () => {
    expect(resolveRequiredReviewers(cfg, ["openai"]).sort()).toEqual(["anthropic", "gemini"]);
    expect(resolveRequiredReviewers(cfg, ["openai", "anthropic"])).toEqual(["gemini"]);
  });

  it("doctor flags a writing vendor that leaves fewer than 2 independent reviewers, including one only a revise chain adds", () => {
    expect(findReviewerIndependenceGaps({ authMode: "subscription", chains: ChainsSchema.parse({ implement: [{ provider: "codex" }], revise: [{ provider: "codex" }], rebase: [{ provider: "codex" }] }), reviewerChain: [{ provider: "agy" }, { provider: "claude" }] })).toEqual([]);
    expect(
      findReviewerIndependenceGaps({
        authMode: "subscription",
        chains: ChainsSchema.parse({ implement: [{ provider: "codex" }], revise: [{ provider: "claude" }], rebase: [{ provider: "codex" }] }),
        reviewerChain: [{ provider: "agy" }, { provider: "claude" }],
      }),
    ).toEqual(["anthropic"]);
  });
});
