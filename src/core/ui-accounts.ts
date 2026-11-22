import path from "node:path";
import { DEFAULT_ACCOUNTS, accountsFor, expandHome, providerToVendor, type CliProvider } from "../config.js";
import type { Ledger } from "../ledger/store.js";
import { AGY_HOME_WARNING } from "./doctor.js";
import { buildSettingsState } from "./ui-settings.js";

export interface AccountRow {
  id: string;
  provider: CliProvider;
  vendor: string;
  /** The configured path only, resolved. Nothing inside it is ever opened. Null means the CLI's default home. */
  home: string | null;
  cooldownUntil: number | null;
  attemptsToday: number;
  maxAttemptsPerDay: number | null;
  lastUsedAt: number | null;
  /** The most recent limit error that moved work off this account (kept after the cooldown ends). */
  lastSwitch: { at: number; reason: string } | null;
  roles: string[];
}

export type AccountsState =
  | { state: "ok"; generatedAt: number; implicit: boolean; accounts: AccountRow[]; warnings: string[] }
  | { state: "missing" | "invalid" | "unreadable"; generatedAt: number; error: string };

/** Pure read: the config on disk plus the Ledger's cooldown and attempt rows. No account home is opened and no usage reading is taken. */
export function buildAccountsState(ledger: Ledger, configPath: string | undefined, now = Date.now()): AccountsState {
  const { host } = buildSettingsState(ledger, configPath, now);
  if (host.state !== "ok") return { state: host.state, generatedAt: now, error: host.error };
  const c = host.config;
  const state = ledger.accountState(c.accounts);
  const switches = new Map(ledger.listAccountSwitches().map((s) => [s.account, s]));
  const chains: Array<[string, typeof c.reviewerChain]> = [...Object.entries(c.chains), ["review", c.reviewerChain]];
  const accounts = c.accounts.map((a): AccountRow => {
    const sw = switches.get(a.id);
    return {
      id: a.id,
      provider: a.provider,
      vendor: providerToVendor(a.provider),
      home: a.home ? path.resolve(expandHome(a.home)) : null,
      cooldownUntil: state.cooldownUntil(a.id, now),
      attemptsToday: state.attemptsToday(a.id, now),
      maxAttemptsPerDay: a.maxAttemptsPerDay ?? null,
      lastUsedAt: state.lastUsedAt(a.id),
      lastSwitch: sw ? { at: sw.at, reason: sw.reason } : null,
      roles: chains.filter(([, chain]) => chain.some((e) => accountsFor(c.accounts, e).some((x) => x.id === a.id))).map(([role]) => role),
    };
  });
  const warnings = c.authMode === "subscription" && c.accounts.filter((a) => a.provider === "agy").length > 1 ? [AGY_HOME_WARNING] : [];
  const implicit = c.accounts.length === DEFAULT_ACCOUNTS.length && c.accounts.every((a, i) => a.id === DEFAULT_ACCOUNTS[i]!.id && !a.home && a.maxAttemptsPerDay === undefined);
  return { state: "ok", generatedAt: now, implicit, accounts, warnings };
}
