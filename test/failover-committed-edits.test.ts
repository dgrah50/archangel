import { localAt } from "./helpers/local-workspaces.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";

describe("implementer vendor tracking across failover", () => {
  it("records a vendor that COMMITTED work before hitting its limit, so it cannot review its own code", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-failover-commit-"));
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-b", "main");
    git("config", "user.name", "T");
    git("config", "user.email", "t@example.com");
    fs.writeFileSync(path.join(repo, "a.go"), "package a\n");
    git("add", "-A");
    git("commit", "-m", "init");
    try {
      const impl = new SubscriptionImplementer({
        chains: { implement: [{ provider: "codex" }, { provider: "agy" }], revise: [{ provider: "codex" }, { provider: "agy" }], rebase: [{ provider: "codex" }, { provider: "agy" }] },
        transcriptsDir: path.join(tmp, "transcripts"),
        invoker: async (input) => {
          if (input.provider === "codex") {
            // codex does real work, commits it (the prompt asks for commits), then runs out of quota: tree is clean.
            fs.writeFileSync(path.join(repo, "a.go"), "package a\n// codex wrote this\n");
            git("commit", "-am", "codex work");
            return { code: 1, stdout: "", stderr: "HTTP 429: usage limit reached", aborted: false };
          }
          return { code: 0, stdout: JSON.stringify({ response: "finished" }), stderr: "", aborted: false };
        },
      });
      const res = await impl.run({
        issueNumber: 1,
        workspaces: localAt(repo),
        prompt: "fix",
        abortController: new AbortController(),
        maxTurns: 1,
        timeoutMs: 1000,
        maxBudgetUsd: 1, role: "implement" as const,
      });
      expect(res.providersUsed).toEqual(expect.arrayContaining(["openai", "gemini"]));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
