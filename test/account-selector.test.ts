import { localAt } from "./helpers/local-workspaces.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";
import { SubscriptionReviewerSuite } from "../src/agents/subscription-reviewers.js";
import type { Account } from "../src/config.js";
import { MAX_ACCOUNT_SWITCHES, NO_ACCOUNT_STATE, selectAccount, type AccountLedger, type AccountState } from "../src/core/accounts.js";
import { Ledger } from "../src/ledger/store.js";

const NOW = Date.UTC(2026, 2, 10, 15, 0, 0);
const claude = (id: string, extra: Partial<Account> = {}): Account => ({ id, provider: "claude", ...extra });
const state = (o: { cooling?: string[]; today?: Record<string, number>; last?: Record<string, number>; pct?: Record<string, number> } = {}): AccountState => ({
  cooldownUntil: (id) => (o.cooling?.includes(id) ? NOW + 60_000 : null),
  attemptsToday: (id) => o.today?.[id] ?? 0,
  lastUsedAt: (id) => o.last?.[id] ?? null,
  usedPercent: (a) => o.pct?.[a.id] ?? null,
});

describe("selectAccount", () => {
  const a = claude("a");
  const b = claude("b");
  const c = claude("c");

  it("skips accounts in cooldown and accounts over their per-account daily cap", () => {
    expect(selectAccount([a, b, c], state({ cooling: ["a"] }), NOW)?.id).toBe("b");
    const capped = claude("a", { maxAttemptsPerDay: 2 });
    expect(selectAccount([capped, b], state({ today: { a: 2 } }), NOW)?.id).toBe("b");
    expect(selectAccount([capped, b], state({ today: { a: 1, b: 1 } }), NOW)?.id).toBe("a");
  });

  it("returns null when every account is cooling, capped or excluded; ignoreCooldown lifts only the cooldown", () => {
    expect(selectAccount([a, b], state({ cooling: ["a", "b"] }), NOW)).toBeNull();
    expect(selectAccount([a, b], state({ cooling: ["a", "b"] }), NOW, { ignoreCooldown: true })?.id).toBe("a");
    expect(selectAccount([claude("a", { maxAttemptsPerDay: 1 })], state({ cooling: ["a"], today: { a: 1 } }), NOW, { ignoreCooldown: true })).toBeNull();
    expect(selectAccount([a, b], NO_ACCOUNT_STATE, NOW, { exclude: new Set(["a", "b"]) })).toBeNull();
  });

  it("breaks ties deterministically: fewer attempts today, then the lower stale usage reading, then config order", () => {
    expect(selectAccount([a, b], state({ today: { a: 3, b: 1 } }), NOW)?.id).toBe("b");
    expect(selectAccount([a, b], state({ pct: { a: 80, b: 20 } }), NOW)?.id).toBe("b");
    expect(selectAccount([a, b], state({ pct: { a: 20, b: 20 } }), NOW)?.id).toBe("a");
    // the reading never outranks recency: a recently used low-usage account loses to an idle high-usage one
    expect(selectAccount([a, b], state({ last: { a: 500 }, pct: { a: 1, b: 99 } }), NOW)?.id).toBe("b");
  });
});

describe("Ledger account state", () => {
  it("cools down per account, counts attempts per local day, and tracks last use across attempts and reviews", () => {
    const l = new Ledger(":memory:", { repo: "a/b", timeZone: "UTC" });
    l.upsertThread({ issueNumber: 1, title: "t", bodySha256: "s", now: 1 });
    const accounts = [claude("a"), claude("b")];
    const s = l.accountState(accounts);
    l.setAccountCooldown("a", 60_000, "limit", NOW);
    expect(s.cooldownUntil("a", NOW)).toBe(NOW + 60_000);
    expect(s.cooldownUntil("b", NOW)).toBeNull();
    expect(s.cooldownUntil("a", NOW + 61_000)).toBeNull();
    expect(l.listActiveCooldowns(NOW)).toEqual([{ account: "a", untilTs: NOW + 60_000, reason: "limit" }]);

    const at = (when: number) => {
      const att = l.startAttempt(1, "implement", when);
      l.recordAttemptProvenance(att.id, { provider: "claude", accountId: "a" });
    };
    at(NOW - 3_600_000);
    at(NOW - 2 * 86_400_000); // not today
    expect(s.attemptsToday("a", NOW)).toBe(1);
    expect(s.lastUsedAt("b")).toBeNull();
    l.recordReview({ issueNumber: 1, headSha: "h", vendor: "anthropic", verdict: "approve", findings: [], costUsd: 0, accountId: "b", now: NOW - 100 });
    expect(s.lastUsedAt("b")).toBe(NOW - 100);
    expect(s.lastUsedAt("a")).toBe(NOW - 3_600_000);
    expect(l.getAttempt(1)?.accountId).toBe("a");
    expect(l.getReviewsForSha(1, "h")[0]!.accountId).toBe("b");
  });

});

function implementer(opts: { accounts: Account[]; chain: Array<{ provider: "claude" | "codex"; accounts?: string[] }>; limited: string[]; state?: AccountLedger }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arc-sel-"));
  const ran: string[] = [];
  const cooled: string[] = [];
  const st: AccountLedger = opts.state ?? { ...NO_ACCOUNT_STATE, recordCooldown: (id) => void cooled.push(id) };
  const chain = opts.chain as never;
  const impl = new SubscriptionImplementer({
    chains: { implement: chain, revise: chain, rebase: chain },
    accounts: opts.accounts,
    accountState: opts.state ?? st,
    transcriptsDir: path.join(tmp, "t"),
    invoker: async ({ account }) => {
      ran.push(account!.id);
      return opts.limited.includes(account!.id)
        ? { code: 1, stdout: "", stderr: "HTTP 429: usage limit reached", aborted: false }
        : { code: 0, stdout: "{}", stderr: "", aborted: false };
    },
  });
  const run = () => impl.run({ issueNumber: 1, workspaces: localAt(tmp), prompt: "p", abortController: new AbortController(), timeoutMs: 1000, role: "implement" });
  return { run, ran, cooled };
}

describe("failover inside an Attempt", () => {
  const accounts: Account[] = [claude("claude-a"), claude("claude-b"), { id: "codex", provider: "codex" }];

  it("tries the next account of the SAME vendor before the next chain entry, cooling the limited account down", async () => {
    const t = implementer({ accounts, chain: [{ provider: "claude" }, { provider: "codex" }], limited: ["claude-a"] });
    const res = await t.run();
    expect(t.ran).toEqual(["claude-a", "claude-b"]);
    expect(t.cooled).toEqual(["claude-a"]);
    expect(res.runBy?.accountId).toBe("claude-b");
    expect(res.providersUsed).toEqual(["anthropic"]);
  });

  it("stops after at most 4 switches, failing with the quota error", async () => {
    const many = Array.from({ length: 8 }, (_, i) => claude(`c${i}`));
    const t = implementer({ accounts: many, chain: [{ provider: "claude" }], limited: many.map((m) => m.id) });
    await expect(t.run()).rejects.toThrow(/account switch limit \(4\) reached.*usage limit/s);
    expect(MAX_ACCOUNT_SWITCHES).toBe(4);
    expect(t.ran).toHaveLength(MAX_ACCOUNT_SWITCHES + 1);
  });

  it("an account cooling from an earlier Attempt is skipped next time, and a chain entry can be pinned to one account", async () => {
    const st = { ...NO_ACCOUNT_STATE, cooldownUntil: (id: string) => (id === "claude-a" ? Date.now() + 60_000 : null), recordCooldown: () => undefined };
    const t = implementer({ accounts, chain: [{ provider: "claude" }], limited: [], state: st });
    await t.run();
    expect(t.ran).toEqual(["claude-b"]);
    const pinned = implementer({ accounts, chain: [{ provider: "claude", accounts: ["claude-b"] }], limited: [] });
    await pinned.run();
    expect(pinned.ran).toEqual(["claude-b"]);
  });

});

describe("reviewer independence stays by vendor with several accounts", () => {
  const accounts: Account[] = [claude("claude-a"), claude("claude-b"), { id: "codex", provider: "codex" }, { id: "agy", provider: "agy" }];
  const req = { issueNumber: 1, title: "t", body: "b", diffText: "d", touchedFiles: {} } as never;

  it("two accounts of one vendor are never two reviewers", async () => {
    const ran: string[] = [];
    const suite = new SubscriptionReviewerSuite({
      chain: [{ provider: "claude" }, { provider: "codex" }, { provider: "agy" }],
      accounts,
      defaultExcludeVendors: [],
      timeoutMs: 60_000,
      invoker: async (i) => {
        ran.push(`${i.provider}:${i.account!.id}`);
        return { verdict: "approve", findings: [] };
      },
    });
    const out = await suite.reviewAll(req);
    expect(out.results.map((r) => r.vendor).sort()).toEqual(["anthropic", "openai"]);
    expect(ran.filter((r) => r.startsWith("claude")).length).toBe(1);
    expect(out.results.find((r) => r.vendor === "anthropic")?.accountId).toBe("claude-a");
  });

});
