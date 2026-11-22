import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubscriptionImplementer, type CliInvoker } from "../src/agents/subscription-implementer.js";
import { defaultReviewerCliInvoker } from "../src/agents/subscription-reviewers.js";
import { defaultScoutCliInvoker } from "../src/core/scout.js";

const dirs: string[] = [];
const oldPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = oldPath;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agents-fc-"));
  dirs.push(d);
  return d;
};
/** Puts a fake `codex` / `claude` on PATH. */
function fakeCli(name: string, script: string): void {
  const bin = tmp();
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
}

describe("CLI children", () => {
  it("a CLI that exits without reading its prompt does not crash the daemon (no uncaught EPIPE)", async () => {
    fakeCli("claude", "exit 0");
    const big = "x".repeat(2_000_000);
    await defaultReviewerCliInvoker({ provider: "claude", prompt: big, timeoutMs: 5000 }).catch(() => undefined);
    await defaultScoutCliInvoker({ provider: "claude", cloneDir: tmp(), prompt: big, maxProposals: 1, timeoutMs: 5000 }).catch(() => undefined);
  });

  it("a CLI that ignores SIGTERM is killed after a grace period instead of holding the tick", async () => {
    fakeCli("claude", "trap '' TERM\nexec sleep 30"); // an ignored SIGTERM survives exec, so this is one process that cannot be terminated politely
    const started = Date.now();
    await expect(defaultReviewerCliInvoker({ provider: "claude", prompt: "p", timeoutMs: 300 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);
});

describe("provider failover", () => {
  it("a vendor whose workspace cannot be inspected counts as having written code (so it cannot review its own work)", async () => {
    const dir = tmp(); // not a git repository: git status fails
    let calls = 0;
    const invoker: CliInvoker = async () => {
      calls++;
      return calls === 1
        ? { code: 1, stdout: "", stderr: "rate limit exceeded: quota", aborted: false }
        : { code: 0, stdout: JSON.stringify({ result: "done" }), stderr: "", aborted: false };
    };
    const impl = new SubscriptionImplementer({ chains: { implement: [{ provider: "codex" }, { provider: "claude" }], revise: [{ provider: "codex" }], rebase: [{ provider: "codex" }] }, transcriptsDir: tmp(), invoker });
    const res = await impl.run({ issueNumber: 1, cloneDir: dir, prompt: "p", abortController: new AbortController(), maxTurns: 1, timeoutMs: 5000, maxBudgetUsd: 1, role: "implement" });
    expect(res.providersUsed).toEqual(expect.arrayContaining(["openai", "anthropic"]));
  });
});
