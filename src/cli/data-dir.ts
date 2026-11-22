import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { HostYamlSchema } from "../config.js";

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

/** The host settings read-only tools need (no secrets): where the data lives and which CLIs review. */
export function resolveHostSettings(
  opts: { config?: string; dataDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): { dataDir: string; authMode: "subscription" | "api"; reviewerChain: Array<{ provider: "codex" | "agy" | "claude"; model?: string }>; implementerChain: Array<{ provider: "codex" | "agy" | "claude"; model?: string }> } {
  const candidate = opts.config ?? env.ARCHANGEL_CONFIG ?? "archangel.yaml";
  const file = path.resolve(candidate);
  if (!fs.existsSync(file)) throw new Error(`Host config not found: ${file}`);
  const host = HostYamlSchema.parse(parseYaml(fs.readFileSync(file, "utf8")));
  return { dataDir: opts.dataDir ?? host.dataDir, authMode: host.authMode, reviewerChain: host.reviewerChain, implementerChain: host.implementerChain };
}
