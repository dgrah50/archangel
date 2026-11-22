import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubscriptionImplementer, type CliInvoker } from "../src/agents/subscription-implementer.js";
import { defaultReviewerCliInvoker, parseJsonEnvelope } from "../src/agents/subscription-reviewers.js";
import { defaultScoutCliInvoker, parseEnvelope } from "../src/core/scout.js";

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

describe("error envelopes", () => {
  it("an error whose text mentions JSON is still an error (only a line that is not JSON is skipped)", () => {
    const line = JSON.stringify({ is_error: true, error: "JSON schema rejected by the provider" });
    expect(() => parseJsonEnvelope(`noise\n${line}`)).toThrow(/JSON schema rejected/);
    expect(() => parseEnvelope(`noise\n${line}`)).toThrow(/JSON schema rejected/);
    expect(parseJsonEnvelope("not json at all")).toBeUndefined();
    expect(parseEnvelope("not json at all")).toBeUndefined();
  });
});

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
    const impl = new SubscriptionImplementer({ chain: [{ provider: "codex" }, { provider: "claude" }], transcriptsDir: tmp(), invoker });
    const res = await impl.run({ issueNumber: 1, cloneDir: dir, prompt: "p", abortController: new AbortController(), maxTurns: 1, timeoutMs: 5000, maxBudgetUsd: 1 });
    expect(res.providersUsed).toEqual(expect.arrayContaining(["openai", "anthropic"]));
  });
});
