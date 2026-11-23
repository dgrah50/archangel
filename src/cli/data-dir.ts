import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { HostYamlSchema, UiConfigSchema, type Chains } from "../config.js";

/**
 * The data directory for read-only commands (`status`, `metrics`, `ui`, ...). `--data-dir` wins; otherwise it comes from the host
 * config file (`--config`, `ARCHANGEL_CONFIG`, or ./archangel.yaml when present). A config file that fails validation is an error:
 * silently opening `.archangel/ledger.db` instead would show (or create) the wrong Ledger.
 */
export function resolveDataDir(opts: { config?: string; dataDir?: string }, env: NodeJS.ProcessEnv = process.env): string {
  if (opts.dataDir) return opts.dataDir;
  const candidate = opts.config ?? env.ARCHANGEL_CONFIG ?? "archangel.yaml";
  if (opts.config || fs.existsSync(path.resolve(candidate))) {
    return HostYamlSchema.parse(parseYaml(fs.readFileSync(path.resolve(candidate), "utf8"))).dataDir;
  }
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
  const candidate = opts.config ?? env.ARCHANGEL_CONFIG ?? "archangel.yaml";
  const file = path.resolve(candidate);
  const ui =
    opts.config || fs.existsSync(file)
      ? HostYamlSchema.parse(parseYaml(fs.readFileSync(file, "utf8"))).ui
      : UiConfigSchema.parse(undefined);
  return { host: opts.host ?? ui.host, port: opts.port !== undefined ? Number(opts.port) : ui.port };
}

/** The host settings read-only tools need (no secrets): where the data lives and which CLIs review. */
export function resolveHostSettings(
  opts: { config?: string; dataDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): { dataDir: string; reviewerChain: Array<{ provider: "codex" | "agy" | "claude"; model?: string }>; chains: Chains } {
  const candidate = opts.config ?? env.ARCHANGEL_CONFIG ?? "archangel.yaml";
  const file = path.resolve(candidate);
  if (!fs.existsSync(file)) throw new Error(`Host config not found: ${file}`);
  const host = HostYamlSchema.parse(parseYaml(fs.readFileSync(file, "utf8")));
  return { dataDir: opts.dataDir ?? host.dataDir, reviewerChain: host.reviewerChain, chains: host.chains };
}
