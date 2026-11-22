import { spawn, type ChildProcess } from "node:child_process";

export const KILL_GRACE_MS = 2000;

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err; // group already gone
  }
}

/**
 * SIGTERM the child's whole process group (the child must be spawned `detached: true`), then SIGKILL the group after
 * `graceMs`. The kill timer is unref'd so it never holds the event loop open. Returns a cancel for the escalation.
 */
export function killGroup(child: ChildProcess, graceMs: number = KILL_GRACE_MS): () => void {
  signalGroup(child, "SIGTERM");
  const t = setTimeout(() => signalGroup(child, "SIGKILL"), graceMs);
  t.unref();
  return () => clearTimeout(t);
}

export interface ExecGroupOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}

export interface ExecGroupError extends Error {
  stdout: string;
  stderr: string;
  code: number | string | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
}

/**
 * execFile-compatible (resolves `{stdout, stderr}`, rejects with `code`/`signal`/`killed`/`stdout`/`stderr`), but the
 * child leads its own process group and a timeout or buffer overflow kills the whole group, so grandchildren die too.
 */
export function execFileGroup(file: string, args: string[], opts: ExecGroupOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let cancelEscalation: (() => void) | undefined;
    const kill = () => {
      if (killed) return;
      killed = true;
      cancelEscalation = killGroup(child);
    };
    const timer = opts.timeout ? setTimeout(kill, opts.timeout) : undefined;
    const append = (which: "out" | "err") => (c: Buffer) => {
      if (which === "out") stdout += c.toString("utf8");
      else stderr += c.toString("utf8");
      if (opts.maxBuffer !== undefined && stdout.length + stderr.length > opts.maxBuffer) kill();
    };
    child.stdout!.on("data", append("out"));
    child.stderr!.on("data", append("err"));
    const fail = (message: string, code: number | string | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(message), { stdout, stderr, code, signal, killed }) as ExecGroupError);
    };
    child.on("error", (err) => fail(err.message, (err as NodeJS.ErrnoException).code ?? null, null));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!killed) cancelEscalation?.();
      if (code === 0 && !killed) resolve({ stdout, stderr });
      else fail(killed ? `Command killed: ${file}` : `Command failed: ${file}`, code, signal);
    });
  });
}
