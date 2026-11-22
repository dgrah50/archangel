import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitBroker } from "../broker/git-broker.js";
import { execInGroup } from "../compute/local.js";
import type { ComputeProvider } from "../compute/provider.js";
import { withholdSecrets } from "./secrets.js";

/** C6: how much of the end of a failing setup's output is shown. */
export const SETUP_TAIL_CHARS = 1500;

export interface SetupVerdict {
  ok: boolean;
  /** True when the script ran under the sandbox profile; false means a scrubbed env in a throwaway clone only. */
  sandboxed: boolean;
  detail: string;
}

const tail = (stdout: string, stderr: string): string => withholdSecrets(`${stdout}${stderr}`.trim().slice(-SETUP_TAIL_CHARS));

/**
 * Dry-runs a `.agents/setup` script in `cloneDir`, a throwaway clone the caller owns. With a sandbox provider the script runs
 * under its install profile (no credentials, no home access, writes only to the clone and a per-run dir); without one it runs
 * with the same scrubbed env the daemon uses and a throwaway HOME. The reported tail is capped and secret-scanned.
 */
export async function runSetupDryRun(opts: { script: string; cloneDir: string; timeoutMs: number; sandbox: Pick<ComputeProvider, "install"> | null }): Promise<SetupVerdict> {
  const argv = ["/bin/sh", "-eu", "-c", opts.script];
  let res;
  let home: string | null = null;
  try {
    if (opts.sandbox) {
      res = await opts.sandbox.install({ id: opts.cloneDir, path: opts.cloneDir }, { argv, timeoutMs: opts.timeoutMs });
    } else {
      home = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-setup-home-"));
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
      res = await execInGroup(opts.cloneDir, { cmd: argv[0]!, args: argv.slice(1), env, timeoutMs: opts.timeoutMs });
    }
  } catch (err) {
    return { ok: false, sandboxed: opts.sandbox !== null, detail: withholdSecrets(err instanceof Error ? err.message : String(err)) };
  } finally {
    if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  const where = opts.sandbox ? "sandboxed" : "NOT sandboxed (no sandbox on this machine)";
  if (res.code === 0) return { ok: true, sandboxed: opts.sandbox !== null, detail: `setup passed in ${Math.round(res.durationMs / 1000)}s, ${where}` };
  const why = res.aborted || res.code === null ? `timed out after ${opts.timeoutMs} ms` : `exited ${res.code}`;
  return { ok: false, sandboxed: opts.sandbox !== null, detail: `setup ${why}, ${where}. Tail:\n${tail(res.stdout, res.stderr)}` };
}

/** Reads `.agents/setup` at the broker's default-branch tip, clones it throwaway, dry-runs it, and removes the clone. */
export async function verifyRepoSetup(opts: { broker: GitBroker; defaultBranch: string; timeoutMs: number; sandbox: Pick<ComputeProvider, "install"> | null }): Promise<SetupVerdict> {
  const mainSha = await opts.broker.resolveRef(opts.defaultBranch);
  const script = await opts.broker.readFileAtRef(mainSha, ".agents/setup");
  if (!script || !script.trim()) return { ok: true, sandboxed: false, detail: `no .agents/setup at ${mainSha.slice(0, 8)}; nothing to verify` };
  const cloneDir = await opts.broker.createThrowawayClone(0, mainSha);
  try {
    return await runSetupDryRun({ script, cloneDir, timeoutMs: opts.timeoutMs, sandbox: opts.sandbox });
  } finally {
    opts.broker.removeClone(cloneDir);
  }
}
