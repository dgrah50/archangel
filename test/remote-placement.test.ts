import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";
import type { ComputeProvider, ExecResult, ExecSpec } from "../src/compute/provider.js";
import { remoteAttemptProvider } from "../src/compute/sail-sdk.js";

function fakeCompute(remote: boolean, respond: (spec: ExecSpec) => Partial<ExecResult>) {
  const calls: ExecSpec[] = [];
  const compute: ComputeProvider = {
    remote,
    prepare: async () => ({ id: "w", path: "/w" }),
    exec: async (_ws, spec) => {
      calls.push(spec);
      return { code: 0, stdout: "", stderr: "", aborted: false, durationMs: 1, peakRssKb: null, ...respond(spec) };
    },
    collect: async () => ({ kind: remote ? "bundle" : "clone", path: "/x" }),
    destroy: () => undefined,
    expose: async () => {
      throw new Error("no");
    },
    list: async () => [],
  };
  return { compute, calls };
}

describe("placing chain entries on local and remote providers", () => {
  it("runs codex locally and claude on the remote box, and no host credential env reaches the remote exec", async () => {
    const local = fakeCompute(false, (s) => (s.cmd === "codex" ? { code: 1, stderr: "HTTP 429: usage limit reached" } : {}));
    const remote = fakeCompute(true, (s) => (s.cmd === "claude" ? { stdout: JSON.stringify({ result: "done" }) } : {}));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-place-"));
    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "host-secret";
      const chain = [{ provider: "codex" as const }, { provider: "claude" as const }];
      const impl = new SubscriptionImplementer({
        chains: { implement: chain, revise: chain, rebase: chain },
        accounts: [
          { id: "codex", provider: "codex", home: "/host/codex-home" },
          { id: "claude", provider: "claude", home: "/host/claude-home" },
        ],
        transcriptsDir: dir,
      });
      const res = await impl.run({
        issueNumber: 1,
        workspaces: {
          local: { compute: local.compute, workspace: async () => ({ id: "l", path: "/l" }) },
          remote: { compute: remote.compute, workspace: async () => ({ id: "r", path: "/r" }) },
        },
        prompt: "p",
        abortController: new AbortController(),
        maxTurns: 1,
        timeoutMs: 1000,
        maxBudgetUsd: 1,
        role: "implement",
      });
      expect(local.calls.some((c) => c.cmd === "codex")).toBe(true);
      expect(local.calls.some((c) => c.cmd === "claude")).toBe(false);
      expect(remote.calls.some((c) => c.cmd === "codex")).toBe(false);
      expect(res.ranOn).toBe("remote");
      const remoteEnvs = remote.calls.map((c) => c.env);
      expect(remote.calls.some((c) => c.cmd === "claude")).toBe(true);
      for (const env of remoteEnvs) {
        expect(Object.keys(env).filter((k) => /CLAUDE_CONFIG_DIR|CODEX_HOME|TOKEN|HOME|KEY/.test(k))).toEqual([]);
      }
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps implement Attempts local when provider is sail but remoteClaudeAttempts is false", () => {
    const base = { authMode: "subscription", compute: { provider: "sail", sail: { app: "arch", remoteClaudeAttempts: false } } };
    const sail = {};
    expect(remoteAttemptProvider(base as never, sail)).toBeUndefined();
    expect(remoteAttemptProvider({ ...base, compute: { provider: "sail", sail: { app: "arch", remoteClaudeAttempts: true } } } as never, sail)).toBe(sail);
  });
});
