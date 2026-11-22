import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";
import { SubscriptionReviewerSuite } from "../src/agents/subscription-reviewers.js";
import { ChainsSchema, resolveRequiredReviewers } from "../src/config.js";
import { computeBlockers, isShadowReady } from "../src/core/blockers.js";

describe("subscription CLI failover (Continuity-style) & cross-vendor review independence", () => {
  it("fails over implementer from codex to agy on quota/rate-limit with Continuity context, and does NOT fail over on non-quota errors", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-sub-test-"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@local"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "a.go"), "package a\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    try {
      const seenPrompts: Array<{ provider: string; prompt: string }> = [];
      const cooledDown = new Set<string>();
      const impl = new SubscriptionImplementer({
        chains: { implement: [{ provider: "codex" }, { provider: "agy" }], revise: [{ provider: "codex" }, { provider: "agy" }], rebase: [{ provider: "codex" }, { provider: "agy" }] },
        transcriptsDir: path.join(tmp, "transcripts"),
        accountState: {
          cooldownUntil: (id) => (cooledDown.has(id) ? Date.now() + 60_000 : null),
          attemptsToday: () => 0,
          lastUsedAt: () => null,
          recordCooldown: (id) => void cooledDown.add(id),
        },
        invoker: async (input) => {
          seenPrompts.push({ provider: input.provider, prompt: input.prompt });
          if (input.provider === "codex") {
            fs.writeFileSync(path.join(repo, "a.go"), "package a\n// partial progress\n");
            return { code: 1, stdout: "", stderr: "HTTP 429: usage limit reached, try again later", aborted: false };
          }
          return {
            code: 0,
            stdout: JSON.stringify({ response: "Fixed via agy fallback" }),
            stderr: "",
            aborted: false,
          };
        },
      });

      const res = await impl.run({
        issueNumber: 13,
        cloneDir: repo,
        prompt: "Fix SSH_CONNECTION",
        abortController: new AbortController(),
        maxTurns: 10,
        timeoutMs: 10_000,
        maxBudgetUsd: 5, role: "implement" as const,
      });

      expect(res.aborted).toBe(false);
      expect(res.costUsd).toBe(0);
      // Both codex (wrote partial edit before 429) and agy (finished) are recorded so neither can review (Opus B1)!
      expect(res.providersUsed?.sort()).toEqual(["gemini", "openai"]);
      expect(seenPrompts.map((p) => p.provider)).toEqual(["codex", "agy"]);
      expect(seenPrompts[1]?.prompt).toContain("CONTINUITY HANDOFF CONTEXT");
      expect(seenPrompts[1]?.prompt).toContain("a.go");
      expect(cooledDown.has("codex")).toBe(true);

      // Next attempt immediately skips cooling-down codex and routes straight to agy!
      seenPrompts.length = 0;
      const res2 = await impl.run({
        issueNumber: 15,
        cloneDir: repo,
        prompt: "Fix next bug",
        abortController: new AbortController(),
        maxTurns: 10,
        timeoutMs: 10_000,
        maxBudgetUsd: 5, role: "implement" as const,
      });
      expect(seenPrompts.map((p) => p.provider)).toEqual(["agy"]);
      expect(res2.providersUsed).toEqual(["gemini"]);

      // Non-quota crash with "429" / "capacity" inside test stdout must NOT trigger false quota failover (Opus B2)!
      const failFast = new SubscriptionImplementer({
        chains: { implement: [{ provider: "codex" }, { provider: "agy" }], revise: [{ provider: "codex" }, { provider: "agy" }], rebase: [{ provider: "codex" }, { provider: "agy" }] },
        transcriptsDir: path.join(tmp, "transcripts"),
        invoker: async (input) => {
          if (input.provider === "codex") {
            return {
              code: 1,
              stdout: '{"type":"item.completed","text":"FAIL TestRateLimit429: capacity exceeded"}\n',
              stderr: "test failed",
              aborted: false,
            };
          }
          throw new Error("should not reach fallback on non-quota error");
        },
      });
      await expect(
        failFast.run({
          issueNumber: 14,
          cloneDir: repo,
          prompt: "Fix bug",
          abortController: new AbortController(),
          maxTurns: 10,
          timeoutMs: 10_000,
          maxBudgetUsd: 5, role: "implement" as const,
        }),
      ).rejects.toThrow(/test failed/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("excludes implementer vendor from independent reviewers and fails over a rate-limited reviewer to a 3rd independent vendor", async () => {
    const called: string[] = [];
    const suite = new SubscriptionReviewerSuite({
      chain: [{ provider: "agy" }, { provider: "claude" }, { provider: "codex" }],
      defaultExcludeVendors: ["openai"], // codex implemented -> must NEVER review!
      invoker: async (input) => {
        called.push(input.provider);
        return { verdict: "approve", findings: [] };
      },
    });

    const out = await suite.reviewAll({
      issueNumber: 13,
      title: "SSH_CONNECTION",
      body: "bug",
      headSha: "abc",
      diffText: "+line",
      touchedFiles: { "a.go": "pkg" },
    });

    expect(called.sort()).toEqual(["agy", "claude"]);
    expect(out.results.map((r) => r.vendor).sort()).toEqual(["anthropic", "gemini"]);
    expect(out.errors).toEqual([]);

    // Opus B1: when ONLY agy ran (because codex was in cooldown), codex + claude are BOTH eligible!
    const cfg = {
      authMode: "subscription" as const,
      chains: ChainsSchema.parse({ implement: [{ provider: "codex" }, { provider: "agy" }], revise: [{ provider: "codex" }, { provider: "agy" }], rebase: [{ provider: "codex" }, { provider: "agy" }] }),
      reviewerChain: [{ provider: "agy" as const }, { provider: "claude" as const }, { provider: "codex" as const }],
    };
    expect(resolveRequiredReviewers(cfg, ["gemini"]).sort()).toEqual(["anthropic", "openai"]);

    // Opus B1: when BOTH codex and agy touched the thread, only 1 reviewer remains -> blockers MUST fail closed!
    const remaining = resolveRequiredReviewers(cfg, ["openai", "gemini"]);
    expect(remaining).toEqual(["anthropic"]);
    const blockers = computeBlockers({
      prOpen: true,
      prDraft: false,
      headSha: "abc",
      shaRecordedByBroker: true,
      postHandoff: false,
      labels: ["ready-for-agent"],
      pauseLabel: "factory:paused",
      stopLabel: "factory:stop",
      circuitBreakerTripped: false,
      mainTipGreen: true,
      branchUpToDateWithMain: true,
      protectedFilesTouched: [],
      requiredChecks: ["Gate"],
      checks: [{ id: 1, name: "Gate", status: "completed", conclusion: "success", appSlug: "github-actions" }],
      reviewsForHeadSha: [
        { id: 1, repo: "acme/app", issueNumber: 13, headSha: "abc", vendor: "anthropic", verdict: "approve", findingsJson: "[]", costUsd: 0, createdAt: 1, provider: null, model: null, accountId: null, promptSha256: null, rubricSha256: null, workflowSha256: null, },
      ],
      requiredReviewers: remaining,
      mergeTreeClean: true,
      autoMergesToday: 0,
      maxAutoMergesPerDay: 3,
      shadowMode: true,
    });
    expect(blockers.map((b) => b.code)).toContain("insufficient_independent_reviewers");
    expect(isShadowReady(blockers)).toBe(false);
  });
});
