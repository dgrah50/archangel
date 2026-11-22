import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { AttemptError } from "../src/ledger/schema.js";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";

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

  it("retries a network drop once on the same account, then fails; an exit-0 headless denial with no work is a failure", async () => {
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
      const chain = [{ provider: "codex" as const }];
      const make = (invoker: ConstructorParameters<typeof SubscriptionImplementer>[0]["invoker"]) =>
        new SubscriptionImplementer({ chains: { implement: chain, revise: chain, rebase: chain }, transcriptsDir: path.join(tmp, "t"), networkRetryWaitMs: 0, invoker });
      const run = (impl: SubscriptionImplementer) =>
        impl.run({ issueNumber: 1, cloneDir: repo, prompt: "Fix", abortController: new AbortController(), maxTurns: 10, timeoutMs: 10_000, maxBudgetUsd: 5, role: "implement" as const });

      let calls = 0;
      const dropped = make(async () => {
        calls++;
        return { code: 1, stdout: "", stderr: "Error: read ECONNRESET", aborted: false };
      });
      await expect(run(dropped)).rejects.toMatchObject({ category: "provider_network" });
      expect(calls).toBe(2);

      const denied = make(async () => ({ code: 0, stdout: "{}", stderr: 'jetski: no output produced: a tool required the "command" permission, so it was auto-denied.', aborted: false }));
      const err = await run(denied).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AttemptError);
      expect((err as AttemptError).category).toBe("permission_denied");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

});
