import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface StudioSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
}

/**
 * Builds a strictly read-only, loopback-bound Mastra Studio spawn spec (ADR-0001):
 * - Binds strictly to `127.0.0.1` (never 0.0.0.0).
 * - Refuses if `mastraDbPath === ledgerDbPath`.
 * - Scrubs all GitHub App, Telegram, and LLM API secrets from child process env.
 */
export function buildStudioSpawnSpec(opts: {
  mastraDbPath: string;
  ledgerDbPath: string;
  port?: number;
  host?: string;
}): StudioSpawnSpec {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Archangel Studio must bind strictly to loopback (127.0.0.1), refused: ${host}`);
  }
  const mastraDb = path.resolve(opts.mastraDbPath);
  const ledgerDb = path.resolve(opts.ledgerDbPath);
  if (mastraDb === ledgerDb) {
    throw new Error(`Refusing to start Studio: mastraDbPath === ledgerDbPath (${mastraDb})`);
  }

  const port = opts.port ?? 4111;
  const localBin = path.resolve("node_modules/.bin/mastra");
  const command = fs.existsSync(localBin) ? localBin : "bunx";
  const baseArgs = fs.existsSync(localBin) ? [] : ["mastra"];

  return {
    command,
    args: [...baseArgs, "dev", "--dir", "src/mastra", "--host", "127.0.0.1", "--port", String(port)],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      ARCHANGEL_MASTRA_DB: mastraDb,
    },
    url: `http://127.0.0.1:${port}`,
  };
}

export async function launchStudio(opts: {
  mastraDbPath: string;
  ledgerDbPath: string;
  port?: number;
}): Promise<number> {
  const spec = buildStudioSpawnSpec(opts);
  console.log(`[archangel] Launching read-only Mastra Studio at ${spec.url} (DB: ${spec.env.ARCHANGEL_MASTRA_DB})`);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: spec.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 0));
  });
}
