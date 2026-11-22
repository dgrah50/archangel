import crypto from "node:crypto";
import fs from "node:fs";
import { resolveConfigPath } from "../config.js";
import type { Ledger } from "../ledger/store.js";

/** Every env var Archangel reads, by name only, with the feature that needs it. Values are never read into this table. */
export const ENV_FEATURES: ReadonlyArray<{ name: string; feature: string }> = [
  { name: "ARCHANGEL_GITHUB_APP_ID", feature: "GitHub App" },
  { name: "ARCHANGEL_GITHUB_INSTALLATION_ID", feature: "GitHub App" },
  { name: "ARCHANGEL_GITHUB_BOT_USER_ID", feature: "GitHub App" },
  { name: "ARCHANGEL_GITHUB_PRIVATE_KEY_PEM", feature: "GitHub App (key, inline)" },
  { name: "ARCHANGEL_GITHUB_PRIVATE_KEY_PATH", feature: "GitHub App (key, file)" },
  { name: "ANTHROPIC_API_KEY", feature: "api auth mode" },
  { name: "OPENAI_API_KEY", feature: "api auth mode" },
  { name: "GOOGLE_GENERATIVE_AI_API_KEY", feature: "api auth mode" },
  { name: "GEMINI_API_KEY", feature: "api auth mode (alias)" },
  { name: "PASEO_HOST", feature: "Paseo handoff" },
  { name: "PASEO_HOME", feature: "Paseo handoff" },
  { name: "ARCHANGEL_TELEGRAM_BOT_TOKEN", feature: "Telegram notifications" },
  { name: "ARCHANGEL_TELEGRAM_CHAT_ID", feature: "Telegram notifications" },
];

export const FACT_KEYS = { sha: "host_config_sha256", env: "env_presence", loadedAt: "loaded_at" } as const;

const sha256 = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

/** Daemon, at start: records what it loaded (config bytes hash, which env vars are set as booleans, when). Never stores a value. */
export function recordDaemonFacts(ledger: Ledger, opts: { configPath?: string; env?: NodeJS.ProcessEnv; now?: number } = {}): void {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  ledger.setSystemState(FACT_KEYS.sha, sha256(fs.readFileSync(resolveConfigPath(opts.configPath, env))), now);
  ledger.setSystemState(FACT_KEYS.env, JSON.stringify(Object.fromEntries(ENV_FEATURES.map((e) => [e.name, Boolean(env[e.name])]))), now);
  ledger.setSystemState(FACT_KEYS.loadedAt, String(now), now);
}

export interface HostStatus {
  generatedAt: number;
  /** False until a daemon that records these facts has started against this Ledger. */
  reported: boolean;
  loadedAt: number | null;
  loadedSha256: string | null;
  diskSha256: string | null;
  disk: "ok" | "missing" | "unreadable";
  /** The file on disk differs from what the daemon loaded: host fields apply only after a restart. */
  restartPending: boolean;
  /** Presence by name as the daemon saw it at start; null when not reported or unreadable. */
  envPresence: Record<string, boolean> | null;
}

/** Pure read: the daemon's recorded facts compared with the config file on disk. */
export function buildHostStatus(ledger: Ledger, configPath: string | undefined, now = Date.now(), env: NodeJS.ProcessEnv = process.env): HostStatus {
  const loadedSha = ledger.getSystemState(FACT_KEYS.sha);
  const loadedAtRaw = ledger.getSystemState(FACT_KEYS.loadedAt);
  let envPresence: Record<string, boolean> | null = null;
  try {
    const raw = ledger.getSystemState(FACT_KEYS.env);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && Object.values(parsed).every((v) => typeof v === "boolean")) envPresence = parsed as Record<string, boolean>;
  } catch {
    envPresence = null;
  }
  let diskSha: string | null = null;
  let disk: HostStatus["disk"] = "ok";
  const file = resolveConfigPath(configPath, env);
  if (!fs.existsSync(file)) disk = "missing";
  else {
    try {
      diskSha = sha256(fs.readFileSync(file));
    } catch {
      disk = "unreadable";
    }
  }
  const loadedAt = loadedAtRaw !== null && Number.isFinite(Number(loadedAtRaw)) ? Number(loadedAtRaw) : null;
  return {
    generatedAt: now,
    reported: loadedSha !== null,
    loadedAt,
    loadedSha256: loadedSha,
    diskSha256: diskSha,
    disk,
    restartPending: loadedSha !== null && diskSha !== null && loadedSha !== diskSha,
    envPresence,
  };
}
