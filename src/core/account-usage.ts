import { execFile } from "node:child_process";
import os from "node:os";
import { cliCommand } from "../compute/agy-broker-adapter.js";
import { accountEnv, expandHome, type Account } from "../config.js";

/** One rate-limit window of an account: how much of it is used, and when it resets (null when the CLI does not say). */
export interface UsageWindow {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
}

export interface AccountUsage {
  windows: UsageWindow[];
  observedAt: number;
}

/**
 * Runs the account's `/usage` command and returns its stdout. Injected so tests never start a real CLI. `/usage` is a local slash
 * command of the CLI itself: no model call, no tokens spent. The CLI reads its own login (CLAUDE_CONFIG_DIR / HOME of the account)
 * and prints the numbers; Archangel only reads that output.
 */
export type UsageRunner = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

const RUN_TIMEOUT_MS = 30_000;
/** One `/usage` run per account per interval, however often the dashboard polls. */
export const USAGE_REFRESH_MS = 5 * 60_000;

export const runUsageCli: UsageRunner = (cmd, args, env) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { env, cwd: os.tmpdir(), timeout: RUN_TIMEOUT_MS, maxBuffer: 1_000_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function zonedParts(at: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** The instant at which the wall clock of `timeZone` reads the given date and time. */
function zonedToEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month, day, hour, minute);
  const p = zonedParts(guess, timeZone);
  return guess - (Date.UTC(p.year, p.month, p.day, p.hour, p.minute) - guess);
}

/** Claude prints resets as `Nov 23 at 1:39am (America/Cayman)` (the date is left out when it is today). */
function parseClaudeReset(text: string, now: number): number | null {
  const m = /^(?:([A-Za-z]{3}) (\d{1,2})(?:,| at)? )?(\d{1,2})(?::(\d{2}))?(am|pm)(?: \(([^)]+)\))?/.exec(text.trim());
  if (!m) return null;
  const timeZone = m[6] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hour = (Number(m[3]) % 12) + (m[5] === "pm" ? 12 : 0);
  const minute = Number(m[4] ?? 0);
  try {
    const today = zonedParts(now, timeZone);
    if (m[1]) {
      const month = MONTHS.indexOf(m[1].toLowerCase());
      if (month < 0) return null;
      const at = zonedToEpoch(today.year, month, Number(m[2]), hour, minute, timeZone);
      return at < now ? zonedToEpoch(today.year + 1, month, Number(m[2]), hour, minute, timeZone) : at;
    }
    const at = zonedToEpoch(today.year, today.month, today.day, hour, minute, timeZone);
    return at < now ? at + 24 * 3_600_000 : at;
  } catch (err) {
    // An unknown time zone name makes Intl throw a RangeError: the reset is then simply not known.
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/** `Current session: 22% used · resets Nov 23 at 1:39am (America/Cayman)` and the `Current week (...)` lines. */
export function parseClaudeUsage(stdout: string, now: number): AccountUsage | null {
  const windows: UsageWindow[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^Current (session|week(?: \(([^)]+)\))?): (\d+(?:\.\d+)?)% used(?: · resets (.+))?$/.exec(line.trim());
    if (!m) continue;
    const label = m[1] === "session" ? "5 h" : m[2] && m[2] !== "all models" ? `week, ${m[2]}` : "week";
    windows.push({ label, usedPercent: Number(m[3]), resetsAt: m[4] ? parseClaudeReset(m[4], now) : null });
  }
  return windows.length > 0 ? { windows, observedAt: now } : null;
}

/** Tab separated `<group>\t<Weekly|Five Hour> Limit ...\t<N>%\t<ISO reset>` lines; the percentage is what is left. */
export function parseAgyUsage(stdout: string, now: number): AccountUsage | null {
  const windows: UsageWindow[] = [];
  for (const line of stdout.split("\n")) {
    const [group, what, remaining, reset] = line.split("\t");
    const left = /^(\d+(?:\.\d+)?)%$/.exec(remaining?.trim() ?? "");
    const span = /five hour/i.test(what ?? "") ? "5 h" : /weekly/i.test(what ?? "") ? "week" : null;
    if (!group || !left || !span) continue;
    const resetsAt = reset ? Date.parse(reset.trim()) : Number.NaN;
    windows.push({ label: `${group.trim()} ${span}`, usedPercent: 100 - Number(left[1]), resetsAt: Number.isNaN(resetsAt) ? null : resetsAt });
  }
  return windows.length > 0 ? { windows, observedAt: now } : null;
}

/**
 * Claude and agy usage per account, from the CLI's own `/usage`. The first call answers null and starts a run in the
 * background; later calls answer the last reading and start another only once it is older than USAGE_REFRESH_MS.
 * A failed or unreadable run is a null reading. Only ever called from the local, token-guarded accounts route.
 */
export function createAccountUsage(run: UsageRunner = runUsageCli) {
  const cache = new Map<string, { at: number; usage: AccountUsage | null; running: boolean }>();
  return (account: Account, now: number): AccountUsage | null => {
    if (account.provider === "codex") return null;
    const cli = account.provider;
    const home = account.home ? expandHome(account.home) : "";
    const key = `${cli}:${home}`;
    const entry = cache.get(key);
    if (entry && (entry.running || now - entry.at < USAGE_REFRESH_MS)) return entry.usage;
    const next = { at: now, usage: entry?.usage ?? null, running: true };
    cache.set(key, next);
    const { cmd, args } = cliCommand(account, cli === "agy" ? ["--print-timeout", "20s", "-p", "/usage"] : ["-p", "/usage"]);
    // What the CLI needs to find its login, and nothing else of this process's env (which holds the GitHub App key).
    const env = { PATH: process.env.PATH, HOME: os.homedir(), USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: process.env.LANG ?? "en_US.UTF-8", ...accountEnv(account) };
    run(cmd, args, env)
      .then((out) => (cli === "claude" ? parseClaudeUsage(out, Date.now()) : parseAgyUsage(out, Date.now())))
      .catch(() => null)
      .then((usage) => cache.set(key, { at: Date.now(), usage, running: false }));
    return next.usage;
  };
}
