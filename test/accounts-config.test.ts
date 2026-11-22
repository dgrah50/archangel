import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";
import { SubscriptionReviewerSuite } from "../src/agents/subscription-reviewers.js";
import {
  DEFAULT_ACCOUNTS,
  HostYamlSchema,
  accountEnv,
  accountHomeProblems,
  accountsFor,
  firstAccount,
  loadProjectConfigs,
} from "../src/config.js";

const host = (extra: Record<string, unknown> = {}) => ({ ownerUserId: 1, projects: [{ repo: "a/b" }], ...extra });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "arc-accounts-"));

describe("accounts config", () => {
  it("with no accounts list there is one implicit account per provider on its default home (the list's default value)", () => {
    const h = HostYamlSchema.parse(host());
    expect(h.accounts).toEqual(DEFAULT_ACCOUNTS);
    expect(h.accounts.map((a) => a.id).sort()).toEqual(["agy", "claude", "codex"]);
    expect(h.accounts.every((a) => a.home === undefined)).toBe(true);
    expect(accountEnv(h.accounts[0])).toEqual({});
  });

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

  it("points each CLI at its own login with exactly one variable (claude, codex, agy)", () => {
    expect(accountEnv({ id: "c", provider: "claude", home: "/h/c" })).toEqual({ CLAUDE_CONFIG_DIR: "/h/c" });
    expect(accountEnv({ id: "x", provider: "codex", home: "/h/x" })).toEqual({ CODEX_HOME: "/h/x" });
    expect(accountEnv({ id: "g", provider: "agy", home: "/h/g" })).toEqual({ HOME: "/h/g" });
    expect(accountEnv({ id: "c", provider: "claude", home: "~/.arc/c" }).CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), ".arc/c"));
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

  it("loading a host config fails clearly when an account home is missing or empty", () => {
    const dir = tmpDir();
    const file = path.join(dir, "archangel.yaml");
    const accounts = [{ id: "codex", provider: "codex", home: path.join(dir, "missing") }, { id: "claude", provider: "claude" }, { id: "agy", provider: "agy" }];
    fs.writeFileSync(file, stringify({ ownerUserId: 1, dataDir: dir, accounts, projects: [{ repo: "a/b" }] }));
    expect(() => loadProjectConfigs({ configPath: file, env: {} })).toThrow(/Invalid accounts.*codex: home .* does not exist/);
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

  it("the reviewer suite passes accounts to its invoker without changing which vendors review", async () => {
    const seen: Array<{ provider: string; account?: string }> = [];
    const suite = new SubscriptionReviewerSuite({
      chain: [{ provider: "claude" }, { provider: "codex" }, { provider: "agy" }],
      accounts: [{ id: "claude-a", provider: "claude", home: "/h/a" }, { id: "codex", provider: "codex" }, { id: "agy", provider: "agy" }],
      defaultExcludeVendors: ["openai"],
      invoker: async (i) => {
        seen.push({ provider: i.provider, account: i.account?.id });
        return { verdict: "approve", findings: [] };
      },
    });
    await suite.reviewAll({ issueNumber: 1, title: "t", body: "b", diffText: "d", touchedFiles: {} } as never);
    expect(seen.map((s) => s.provider).sort()).toEqual(["agy", "claude"]);
    expect(seen.find((s) => s.provider === "claude")?.account).toBe("claude-a");
  });
});
