import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryParseJson } from "./json.js";
import { expandHome, type Account } from "../config.js";

/** At most this many account switches (after a limit error) within one Attempt before it fails with the quota error. */
export const MAX_ACCOUNT_SWITCHES = 4;
export const ACCOUNT_COOLDOWN_MS = 15 * 60_000;
/** A CLI-provided usage reading older than this is shown as stale. It is only ever a tie-breaker. */
export const READING_STALE_MS = 30 * 60_000;

/** What the selector may know about each account. Every method is a cheap read; none touches a token. */
export interface AccountState {
  /** Until when the account is cooling down after a limit error, or null. */
  cooldownUntil(accountId: string, now: number): number | null;
  /** Attempts started on this account today (local day), for `maxAttemptsPerDay`. */
  attemptsToday(accountId: string, now: number): number;
  /** The most recent time this account ran an Attempt or a review, or null if it never has. */
  lastUsedAt(accountId: string): number | null;
  /** Optional CLI-provided usage reading (percent of the window used). A hint, never a reason to exclude an account. */
  usedPercent?(account: Account): number | null;
}

export interface AccountLedger extends AccountState {
  recordCooldown(accountId: string, durationMs: number, reason: string, now?: number): void;
}

/** No usage knowledge at all: nothing cools down and nothing has been used, so selection is plain config order. */
export const NO_ACCOUNT_STATE: AccountLedger = {
  cooldownUntil: () => null,
  attemptsToday: () => 0,
  lastUsedAt: () => null,
  recordCooldown: () => undefined,
};

/**
 * Picks the account for a new run among `candidates` (one vendor's accounts). Deterministic and pure:
 *  1. drop excluded accounts, accounts in cooldown (unless `ignoreCooldown`), and accounts over `maxAttemptsPerDay`;
 *  2. least recently used first (an account that never ran goes first);
 *  3. ties: fewer attempts today, then the lower CLI-reported usage reading (a stale hint), then config order.
 * Returns null when nothing is selectable.
 */
export function selectAccount(
  candidates: Account[],
  state: AccountState,
  now: number,
  opts: { exclude?: ReadonlySet<string>; ignoreCooldown?: boolean } = {},
): Account | null {
  const usable = candidates
    .map((account, order) => ({ account, order }))
    .filter(({ account }) => {
      if (opts.exclude?.has(account.id)) return false;
      if (!opts.ignoreCooldown && state.cooldownUntil(account.id, now) !== null) return false;
      if (account.maxAttemptsPerDay !== undefined && state.attemptsToday(account.id, now) >= account.maxAttemptsPerDay) return false;
      return true;
    });
  if (usable.length === 0) return null;
  const key = ({ account, order }: (typeof usable)[number]) => [
    state.lastUsedAt(account.id) ?? Number.NEGATIVE_INFINITY,
    state.attemptsToday(account.id, now),
    state.usedPercent?.(account) ?? 0,
    order,
  ];
  usable.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
    return 0;
  });
  return usable[0]!.account;
}

export interface CodexReading {
  usedPercent: number;
  windowMinutes: number | null;
  observedAt: number;
}

/**
 * The free Codex rate-limit reading in `$CODEX_HOME/sessions/**\/rollout-*.jsonl`: the last `token_count` event's
 * `rate_limits.primary`. It is stale by construction (the account's last model call), so it only breaks ties.
 * Returns null when there is no readable rollout; no token or auth file is ever opened.
 */
export function readCodexUsage(home: string | undefined): CodexReading | null {
  const root = path.join(home ? path.resolve(expandHome(home)) : path.join(os.homedir(), ".codex"), "sessions");
  let newest: { file: string; mtime: number } | null = null;
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return;
      throw err;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        const mtime = fs.statSync(p).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { file: p, mtime };
      }
    }
  };
  walk(root, 0);
  if (!newest) return null;
  const { file, mtime } = newest as { file: string; mtime: number };
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"rate_limits"')) continue;
    const parsed = tryParseJson(lines[i]!);
    if (!parsed.ok) continue;
    const found = findRateLimits(parsed.value);
    if (found) return { usedPercent: found.used_percent, windowMinutes: found.window_minutes ?? null, observedAt: mtime };
  }
  return null;
}

function findRateLimits(v: unknown): { used_percent: number; window_minutes?: number } | null {
  if (typeof v !== "object" || v === null) return null;
  const rl = (v as { rate_limits?: { primary?: { used_percent?: unknown; window_minutes?: unknown } } }).rate_limits;
  const p = rl?.primary;
  if (p && typeof p.used_percent === "number") {
    return { used_percent: p.used_percent, window_minutes: typeof p.window_minutes === "number" ? p.window_minutes : undefined };
  }
  for (const child of Object.values(v as Record<string, unknown>)) {
    const f = findRateLimits(child);
    if (f) return f;
  }
  return null;
}
