import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";

import { HostYamlSchema, accountHomeProblems, accountsFor, firstAccount } from "../src/config.js";

const host = (extra: Record<string, unknown> = {}) => ({ ownerUserId: 1, projects: [{ repo: "a/b" }], ...extra });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "arc-accounts-"));

describe("accounts config", () => {
  it("accepts several accounts per provider, with optional per-account caps and chain entries pinned to account ids", () => {
    const h = HostYamlSchema.parse(
      host({
        accounts: [
          { id: "claude-a", provider: "claude", home: "/h/a", maxAttemptsPerDay: 12 },
          { id: "claude-b", provider: "claude", home: "/h/b" },
          { id: "codex", provider: "codex" },
          { id: "agy", provider: "agy" },
        ],
        chains: { revise: [{ provider: "claude", accounts: ["claude-b"] }, { provider: "codex" }] },
      }),
    );
    expect(accountsFor(h.accounts, h.chains.revise[0]!).map((a) => a.id)).toEqual(["claude-b"]);
    expect(accountsFor(h.accounts, { provider: "claude" }).map((a) => a.id)).toEqual(["claude-a", "claude-b"]);
    expect(firstAccount(h.accounts, { provider: "claude" })?.id).toBe("claude-a");
  });

  it("rejects duplicate ids, a shared home, an unknown or wrong-provider account in a chain, and a chain provider with no account", () => {
    const base = [{ id: "codex", provider: "codex" }, { id: "agy", provider: "agy" }];
    const bad = (extra: Record<string, unknown>) => () => HostYamlSchema.parse(host(extra));
    expect(bad({ accounts: [...base, { id: "codex", provider: "codex" }] })).toThrow(/duplicate account id 'codex'/);
    expect(bad({ accounts: [{ id: "a", provider: "claude", home: "/h/x" }, { id: "b", provider: "claude", home: "/h/x" }, ...base] })).toThrow(/share one home/);
    expect(bad({ accounts: [...base, { id: "claude", provider: "claude" }], chains: { revise: [{ provider: "codex", accounts: ["nope"] }] } })).toThrow(/unknown account 'nope'/);
    expect(bad({ accounts: [...base, { id: "claude", provider: "claude" }], chains: { revise: [{ provider: "codex", accounts: ["claude"] }] } })).toThrow(/is a claude account, not codex/);
    expect(bad({ accounts: base })).toThrow(/no account of that provider is configured/);
    expect(bad({ accounts: [{ id: "Bad_ID", provider: "codex" }, ...base] })).toThrow(/lowercase slug/);
  });

  it("checks that a configured home exists and holds a login (non-empty)", () => {
    const logged = tmpDir();
    fs.writeFileSync(path.join(logged, "auth.json"), "{}");
    const empty = tmpDir();
    const problems = accountHomeProblems([
      { id: "ok", provider: "codex", home: logged },
      { id: "empty", provider: "codex", home: empty },
      { id: "missing", provider: "claude", home: path.join(empty, "nope") },
      { id: "default", provider: "agy" },
    ]);
    expect(problems.map((p) => p.id)).toEqual(["empty", "missing"]);
    expect(problems[0]!.problem).toContain("log this account in");
  });

});

describe("accounts reach the CLI invokers", () => {
  it("the implementer passes the entry's first allowed account to the CLI invoker", async () => {
    const dir = tmpDir();
    const seen: Array<{ provider: string; account?: string }> = [];
    const accounts = [{ id: "claude-a", provider: "claude" as const, home: "/h/a" }, { id: "claude-b", provider: "claude" as const, home: "/h/b" }];
    const chain = [{ provider: "claude" as const, accounts: ["claude-b"] }];
    const impl = new SubscriptionImplementer({
      chains: { implement: chain, revise: chain, rebase: chain },
      accounts,
      transcriptsDir: path.join(dir, "t"),
      invoker: async (i) => {
        seen.push({ provider: i.provider, account: i.account?.id });
        return { code: 0, stdout: "{}", stderr: "", aborted: false };
      },
    });
    await impl.run({ issueNumber: 1, cloneDir: dir, prompt: "p", abortController: new AbortController(), maxTurns: 1, timeoutMs: 1000, maxBudgetUsd: 1, role: "implement" });
    expect(seen).toEqual([{ provider: "claude", account: "claude-b" }]);
  });

});
