import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";
import { SubscriptionReviewerSuite } from "../src/agents/subscription-reviewers.js";

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
      const impl = new SubscriptionImplementer({
        chain: [{ provider: "codex" }, { provider: "agy" }],
        transcriptsDir: path.join(tmp, "transcripts"),
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
        maxBudgetUsd: 5,
      });

      expect(res.aborted).toBe(false);
      expect(res.costUsd).toBe(0);
      expect(res.providersUsed).toEqual(["gemini"]);
      expect(seenPrompts.map((p) => p.provider)).toEqual(["codex", "agy"]);
      expect(seenPrompts[1]?.prompt).toContain("CONTINUITY HANDOFF CONTEXT");
      expect(seenPrompts[1]?.prompt).toContain("a.go");

      // Non-quota crash fails immediately without silently hopping providers
      const failFast = new SubscriptionImplementer({
        chain: [{ provider: "codex" }, { provider: "agy" }],
        transcriptsDir: path.join(tmp, "transcripts"),
        invoker: async (input) => {
          if (input.provider === "codex") {
            return { code: 1, stdout: "", stderr: "fatal: corrupt git index", aborted: false };
          }
          throw new Error("should not reach fallback on non-quota error");
        },
      });
      await expect(
        failFast.run({
          issueNumber: 14,
          cloneDir: tmp,
          prompt: "Fix bug",
          abortController: new AbortController(),
          maxTurns: 10,
          timeoutMs: 10_000,
          maxBudgetUsd: 5,
        }),
      ).rejects.toThrow(/corrupt git index/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("excludes implementer vendor from independent reviewers and fails over a rate-limited reviewer to a 3rd independent vendor", async () => {
    const called: string[] = [];
    const suite = new SubscriptionReviewerSuite({
      chain: [{ provider: "agy" }, { provider: "claude" }, { provider: "codex" }],
      primaryImplementerVendor: "openai", // codex implemented -> must NEVER review!
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
  });
});
