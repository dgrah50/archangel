import path from "node:path";
import { DEFAULT_ACCOUNTS, accountsFor, expandHome, providerToVendor, type Account, type CliProvider } from "../config.js";
import type { AccountUsage } from "./account-usage.js";
import type { Ledger } from "../ledger/store.js";
import { readCodexUsage } from "./accounts.js";
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
  /** Its rate-limit windows (share used, reset time). Codex: from its session log at its last model call. Claude and agy: from the CLI's own `/usage`, cached for minutes. No token or auth file is opened. Null when there is no reading. */
  usage: AccountUsage | null;
  maxAttemptsPerDay: number | null;
  lastUsedAt: number | null;
  /** The most recent limit error that moved work off this account (kept after the cooldown ends). */
  lastSwitch: { at: number; reason: string } | null;
  roles: string[];
}

export type AccountsState =
  | { state: "ok"; generatedAt: number; implicit: boolean; accounts: AccountRow[]; warnings: string[] }
  | { state: "missing" | "invalid" | "unreadable"; generatedAt: number; error: string };

/** The config on disk, the Ledger's cooldown and attempt rows, and the usage readings. No token or auth file in an account home is opened. */
export function buildAccountsState(ledger: Ledger, configPath: string | undefined, cliUsage: (account: Account, now: number) => AccountUsage | null, now = Date.now()): AccountsState {
  const { host } = buildSettingsState(ledger, configPath, now);
  if (host.state !== "ok") return { state: host.state, generatedAt: now, error: host.error };
  const c = host.config;
  const state = ledger.accountState(c.accounts);
  const switches = new Map(ledger.listAccountSwitches().map((s) => [s.account, s]));
  const chains: Array<[string, typeof c.reviewerChain]> = [...Object.entries(c.chains), ["review", c.reviewerChain]];
  const accounts = c.accounts.map((a): AccountRow => {
    const sw = switches.get(a.id);
    const reading = a.provider === "codex" ? readCodexUsage(a.home) : cliUsage(a, now);
    // A window that has reset since the reading was taken no longer says anything.
    const windows = reading?.windows.filter((w) => w.resetsAt === null || w.resetsAt > now) ?? [];
    return {
      id: a.id,
      provider: a.provider,
      vendor: providerToVendor(a.provider),
      home: a.home ? path.resolve(expandHome(a.home)) : null,
      cooldownUntil: state.cooldownUntil(a.id, now),
      attemptsToday: state.attemptsToday(a.id, now),
      usage: reading && windows.length > 0 ? { windows, observedAt: reading.observedAt } : null,
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
