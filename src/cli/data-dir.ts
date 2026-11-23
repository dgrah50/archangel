import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { HostYamlSchema, UiConfigSchema, type Chains } from "../config.js";

/** The host config file: `--config`, else `ARCHANGEL_CONFIG`, else ./archangel.yaml. */
function hostConfigFile(opts: { config?: string }, env: NodeJS.ProcessEnv): string {
  return path.resolve(opts.config ?? env.ARCHANGEL_CONFIG ?? "archangel.yaml");
}

function readHostYaml(file: string) {
  return HostYamlSchema.parse(parseYaml(fs.readFileSync(file, "utf8")));
}

/**
 * The data directory for read-only commands (`status`, `metrics`, `ui`, ...). `--data-dir` wins; otherwise it comes from the host
 * config file (`--config`, `ARCHANGEL_CONFIG`, or ./archangel.yaml when present). A config file that fails validation is an error:
 * silently opening `.archangel/ledger.db` instead would show (or create) the wrong Ledger.
 */
export function resolveDataDir(opts: { config?: string; dataDir?: string }, env: NodeJS.ProcessEnv = process.env): string {
  if (opts.dataDir) return opts.dataDir;
  const file = hostConfigFile(opts, env);
  if (opts.config || fs.existsSync(file)) return readHostYaml(file).dataDir;
  return env.ARCHANGEL_DATA_DIR ?? ".archangel";
}

/**
 * Where the dashboard binds: an explicit flag wins, else `ui` from the host config file (same lookup as `resolveDataDir`),
 * else the defaults when there is no config file. `start` takes its preview-reserved port from the same `ui.port`.
 */
export function resolveUiSettings(
  opts: { config?: string; host?: string; port?: string | number },
  env: NodeJS.ProcessEnv = process.env,
): { host: string; port: number } {
  const file = hostConfigFile(opts, env);
  const ui = opts.config || fs.existsSync(file) ? readHostYaml(file).ui : UiConfigSchema.parse(undefined);
  return { host: opts.host ?? ui.host, port: opts.port !== undefined ? Number(opts.port) : ui.port };
}

/** The host settings read-only tools need (no secrets): where the data lives and which CLIs review. */
export function resolveHostSettings(
  opts: { config?: string; dataDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): { dataDir: string; reviewerChain: Array<{ provider: "codex" | "agy" | "claude"; model?: string }>; chains: Chains; reviewTimeoutMs: number } {
  const file = hostConfigFile(opts, env);
  if (!fs.existsSync(file)) throw new Error(`Host config not found: ${file}`);
  const host = readHostYaml(file);
  return { dataDir: opts.dataDir ?? host.dataDir, reviewerChain: host.reviewerChain, chains: host.chains, reviewTimeoutMs: host.reviewTimeoutMs };
}
