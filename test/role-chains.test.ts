import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";
import { ChainsSchema, HostYamlSchema, resolveRequiredReviewers } from "../src/config.js";
import { findReviewerIndependenceGaps } from "../src/core/doctor.js";
import { selectScoutProvider } from "../src/core/scout.js";
import { Ledger } from "../src/ledger/store.js";

const host = (extra: Record<string, unknown> = {}) => ({ ownerUserId: 1, projects: [{ repo: "a/b" }], ...extra });

describe("host chains config", () => {
  it("rejects an empty implement, revise, rebase, scout or triage chain", () => {
    for (const role of ["implement", "revise", "rebase", "scout", "triage"]) {
      expect(() => HostYamlSchema.parse(host({ chains: { [role]: [] } })), role).toThrow(/at least one provider/);
    }
  });

  it("requires a claude or codex entry in the scout chain (agy has no verified read-only mode)", () => {
    expect(() => ChainsSchema.parse({ scout: [{ provider: "agy" }] })).toThrow(/claude or codex/);
    expect(selectScoutProvider([{ provider: "agy" }, { provider: "claude", model: "m" }])).toMatchObject({ provider: "claude", model: "m" });
  });

  it("the shipped example config parses", () => {
    const example = parseYaml(fs.readFileSync("archangel.example.yaml", "utf8"));
    const parsed = HostYamlSchema.parse(example);
    expect(parsed.chains.revise[0]!.model).toBe("gpt-5.4-mini");
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

  it("vendor stickiness for a revision is by vendor, whatever the model", async () => {
    const r = runner(chains);
    try {
      const res = await r.run("revise", { preferVendors: ["anthropic"] });
      expect(r.calls).toEqual([{ provider: "claude", model: "haiku" }]);
      expect(res.runBy).toEqual({ provider: "claude", model: "haiku", accountId: "claude" });
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

  it("with no Attempt recorded yet, excludes the first vendor of every writing role", () => {
    expect(resolveRequiredReviewers(cfg)).toEqual(["gemini"]);
  });

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

describe("metrics: per-role breakdown", () => {
  it("reports attempts, success rate, metered cost and provider/model per role", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    l.upsertThread({ issueNumber: 1, title: "t", bodySha256: "s", now: 1 });
    const finish = (kind: "implement" | "revise" | "rebase", status: "succeeded" | "failed", provider: string, model: string, cost: number) => {
      const a = l.startAttempt(1, kind, 10);
      l.recordAttemptProvenance(a.id, { provider, model });
      l.finishAttempt(a.id, status === "succeeded" ? { status, costUsd: cost } : { status, costUsd: cost, errorMessage: "x", errorCategory: "other" }, 20);
    };
    finish("implement", "succeeded", "codex", "big", 0.5);
    finish("revise", "succeeded", "codex", "mini", 0);
    finish("revise", "failed", "codex", "mini", 0);
    finish("rebase", "succeeded", "agy", "flash", 0);
    const roles = l.computeMetrics({ now: 100 }).attempts.byRole;
    expect(roles.implement).toMatchObject({ attempts: 1, succeeded: 1, costUsd: 0.5, models: { "codex/big": 1 } });
    expect(roles.revise).toMatchObject({ attempts: 2, succeeded: 1, failed: 1, models: { "codex/mini": 2 } });
    expect(roles.rebase!.models).toEqual({ "agy/flash": 1 });
    l.close();
  });
});
