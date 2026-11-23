import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryParseJson } from "./json.js";
import { expandHome, type Account } from "../config.js";
import type { UsageWindow } from "./account-usage.js";

/** At most this many account switches (after a limit error) within one Attempt before it fails with the quota error. */
export const MAX_ACCOUNT_SWITCHES = 4;
export const ACCOUNT_COOLDOWN_MS = 15 * 60_000;
/**
 * How long an account cools down after a limit error: the provider's own figure when its message gives one ("Resets in 134h23m",
 * "resets in 2 d 4 h"), else the short default, after which the account is simply tried again.
 */
export function cooldownAfterLimit(message: string, fallbackMs = ACCOUNT_COOLDOWN_MS): number {
  const m = /resets? in\s+(?:(\d+)\s*d[a-z]*\s*)?(?:(\d+)\s*h[a-z]*\s*)?(?:(\d+)\s*m[a-z]*)?/i.exec(message);
  const ms = m ? Number(m[1] ?? 0) * 86_400_000 + Number(m[2] ?? 0) * 3_600_000 + Number(m[3] ?? 0) * 60_000 : 0;
  return ms > 0 ? ms : fallbackMs;
}


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
  /** The primary window's share used; the only number the selector uses. */
  usedPercent: number;
  /** The primary and, when Codex reports one, the secondary window. */
  windows: UsageWindow[];
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
    if (found) return { usedPercent: found.windows[0]!.usedPercent, windows: found.windows, observedAt: mtime };
  }
  return null;
}

interface CodexWindowRaw {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

function codexWindow(w: CodexWindowRaw | null | undefined): UsageWindow | null {
  if (!w || typeof w.used_percent !== "number") return null;
  const minutes = typeof w.window_minutes === "number" ? w.window_minutes : null;
  const label = minutes === null ? "limit" : minutes === 10_080 ? "week" : minutes % 1440 === 0 ? `${minutes / 1440} d` : minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
  return { label, usedPercent: w.used_percent, resetsAt: typeof w.resets_at === "number" ? w.resets_at * 1000 : null };
}

function findRateLimits(v: unknown): { windows: UsageWindow[] } | null {
  if (typeof v !== "object" || v === null) return null;
  const rl = (v as { rate_limits?: { primary?: CodexWindowRaw; secondary?: CodexWindowRaw | null } }).rate_limits;
  const primary = codexWindow(rl?.primary);
  if (primary) return { windows: [primary, codexWindow(rl?.secondary)].filter((w): w is UsageWindow => w !== null) };
  for (const child of Object.values(v as Record<string, unknown>)) {
    const f = findRateLimits(child);
    if (f) return f;
  }
  return null;
}
