import fs from "node:fs";
import path from "node:path";
import { tryParseJson } from "../core/json.js";

/**
 * The host-side token broker. A subscription login whose refresh token rotates (codex ChatGPT) can only be refreshed by one
 * holder, so the broker is that holder: it keeps a dedicated account's access token fresh and stores only that access token in
 * a Sail secret. A box holds a placeholder and cannot refresh. The refresh token never leaves this machine.
 *
 * Failure is loud: a failed refresh writes SENTINEL into the secret (a box then sends garbage and gets a 401, never a stale
 * success) and marks the state `failed`; `brokerPreflight` then refuses to start an Attempt until the owner repairs the login.
 */

export const BROKER_SENTINEL = "BROKER_REFRESH_FAILED_do_not_use";
/** Never refresh more often than this, whatever the lifetime says. */
const MIN_REFRESH_DELAY_MS = 60_000;
/** An Attempt must start with this much token life beyond its own timeout. */
export const PREFLIGHT_MARGIN_MS = 60_000;

export interface BrokerAdapter {
  /** Stable id: names the state file. */
  readonly id: string;
  /** The Sail secret this adapter's access token lives in. */
  readonly secretName: string;
  /** Refreshes the login and returns the access token with its expiry (ms epoch) and the non-secret account id. */
  refresh(): Promise<{ accessToken: string; expiresAt: number; accountId: string }>;
}

export interface BrokerState {
  status: "ok" | "failed";
  refreshedAt: number | null;
  expiresAt: number | null;
  /** Measured at the last refresh: expiresAt minus refreshedAt, in seconds. */
  lifetimeSeconds: number | null;
  /** The ChatGPT account id (not a secret): a box's synthetic login needs it. */
  accountId: string | null;
  lastError: string | null;
}

export const brokerStatePath = (dataDir: string, id: string) => path.join(dataDir, "sail-broker", `${id}.json`);

export function readBrokerState(dataDir: string, id: string): BrokerState | null {
  const file = brokerStatePath(dataDir, id);
  if (!fs.existsSync(file)) return null;
  const parsed = tryParseJson(fs.readFileSync(file, "utf8"));
  return parsed.ok ? (parsed.value as BrokerState) : null;
}

/** Throws unless the broker's token is usable for an Attempt that runs up to `attemptMs`. Never refreshes, never touches a login. */
export function brokerPreflight(dataDir: string, id: string, attemptMs: number, now = Date.now()): BrokerState {
  const s = readBrokerState(dataDir, id);
  if (!s) throw new Error(`token broker '${id}' has not refreshed yet: refusing to start the Attempt (is the daemon running?)`);
  if (s.status === "failed") throw new Error(`token broker '${id}' is failed (${s.lastError ?? "unknown error"}): refusing to start the Attempt; repair the dedicated login`);
  if (s.expiresAt === null || s.expiresAt - now < attemptMs + PREFLIGHT_MARGIN_MS) throw new Error(`token broker '${id}' token expires too soon for this Attempt: refusing to start it`);
  return s;
}

export class TokenBroker {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly adapter: BrokerAdapter,
    private readonly dataDir: string,
    private readonly setSecret: (name: string, value: string) => Promise<unknown>,
    private readonly log: (msg: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private write(state: BrokerState): void {
    const file = brokerStatePath(this.dataDir, this.adapter.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
  }

  /** One refresh. On failure the sentinel replaces the secret and the state is `failed`; the loop then stops. Returns the ms to wait before the next one, or null. */
  async refreshOnce(): Promise<number | null> {
    try {
      const at = this.now();
      const r = await this.adapter.refresh();
      await this.setSecret(this.adapter.secretName, r.accessToken);
      this.write({ status: "ok", refreshedAt: at, expiresAt: r.expiresAt, lifetimeSeconds: Math.round((r.expiresAt - at) / 1000), accountId: r.accountId, lastError: null });
      return Math.max(MIN_REFRESH_DELAY_MS, (r.expiresAt - this.now()) / 2);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const prev = readBrokerState(this.dataDir, this.adapter.id);
      await this.setSecret(this.adapter.secretName, BROKER_SENTINEL).catch(() => undefined);
      this.write({ status: "failed", refreshedAt: prev?.refreshedAt ?? null, expiresAt: null, lifetimeSeconds: prev?.lifetimeSeconds ?? null, accountId: prev?.accountId ?? null, lastError: message.slice(0, 300) });
      this.log(`token broker '${this.adapter.id}' failed: ${message}`);
      return null;
    }
  }

  /** Refreshes now (resolves once the first refresh has settled) and then at about half the token's remaining life, until stopped or a refresh fails. */
  start(): Promise<void> {
    const tick = async () => {
      const wait = await this.refreshOnce();
      if (wait === null || this.stopped) return;
      this.timer = setTimeout(() => void tick(), wait);
    };
    return tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
