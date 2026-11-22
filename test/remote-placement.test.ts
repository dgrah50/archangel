import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";
import type { ComputeProvider, ExecResult, ExecSpec } from "../src/compute/provider.js";
import { remoteAttemptProvider, sailPolicyDoc } from "../src/compute/sail-sdk.js";

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
    install: async () => {
      throw new Error("no");
    },
    list: async () => [],
  };
  return { compute, calls };
}

describe("placing chain entries on local and remote providers", () => {
  it("runs a provider on the remote box only when it has a remote credential, and no host login reaches the remote exec", async () => {
    const local = fakeCompute(false, (s) => (s.cmd === "agy" ? { code: 1, stderr: "HTTP 429: usage limit reached" } : {}));
    const remote = fakeCompute(true, () => ({}));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-place-"));
    try {
      process.env.OPENAI_API_KEY = "host-secret";
      const chain = [{ provider: "agy" as const }, { provider: "codex" as const }];
      const impl = new SubscriptionImplementer({
        chains: { implement: chain, revise: chain, rebase: chain },
        accounts: [
          { id: "agy", provider: "agy", home: "/host/agy-home" },
          { id: "codex", provider: "codex", home: "/host/codex-home" },
        ],
        remoteProviders: new Set(["codex"]),
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
      expect(local.calls.some((c) => c.cmd === "agy")).toBe(true);
      expect(remote.calls.some((c) => c.cmd === "agy" || c.args.includes("agy"))).toBe(false);
      expect(res.ranOn).toBe("remote");
      expect(remote.calls.some((c) => c.args.includes("codex"))).toBe(true);
      for (const c of remote.calls) {
        expect(Object.keys(c.env).filter((k) => /CLAUDE_CONFIG_DIR|CODEX_HOME|TOKEN|HOME|KEY/.test(k))).toEqual([]);
      }
    } finally {
      delete process.env.OPENAI_API_KEY;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps Attempts local unless a provider has a remote credential", () => {
    const sail = {};
    const cfg = (extra: object) => ({ authMode: "subscription", compute: { provider: "sail", sail: { app: "arch", remoteClaudeAttempts: false, ...extra } } }) as never;
    expect(remoteAttemptProvider(cfg({}), sail)).toBeUndefined();
    expect(remoteAttemptProvider(cfg({ codexApiKeySecret: "K" }), sail)).toBe(sail);
  });

  it("never lets a box reach an OAuth host, and names only the secrets, never their values", () => {
    const doc = sailPolicyDoc({ claudeTokenSecret: "C", codexApiKeySecret: "O", geminiApiKeySecret: "G" });
    expect(doc.allowlist).toEqual(["api.anthropic.com", "api.openai.com", "generativelanguage.googleapis.com", "registry.npmjs.org"]);
    expect(sailPolicyDoc({ claudeTokenSecret: "C", codexBrokerHome: "/h" }).allowlist).toEqual(["api.anthropic.com", "chatgpt.com", "registry.npmjs.org"]);
    expect(doc.rules["generativelanguage.googleapis.com"]![0]!.request.replace.headers).toEqual({ "x-goog-api-key": "G" });
  });
});
