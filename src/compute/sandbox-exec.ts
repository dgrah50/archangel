import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { killGroup, KILL_GRACE_MS } from "../core/spawn-group.js";
import { execInGroup } from "./local.js";
import type { CollectedResult, ComputeProvider, ExecResult, ExecSpec, Exposed, ExposeSpec, ListedPreview, PrepareSpec, Workspace } from "./provider.js";

/**
 * A macOS `sandbox-exec` provider: untrusted agent-written code runs under a generated Seatbelt profile, never as a bare
 * process. The profile denies by default and allows only: reads of the workspace, a tmp dir and the read-only toolchain
 * below; writes to the workspace and the tmp dir; exec of the toolchain; and the network on 127.0.0.1 only.
 *
 * Installs do NOT run here. Seatbelt filters network by IP and port, not by hostname, so "registry hosts for the install
 * step only" cannot be enforced; dependencies must be installed in the build phase, before the sandboxed run.
 */

export const PREVIEW_PREFIX = "archangel-preview-";
export const PREVIEW_TTL_MS = 60 * 60_000;
export const PREVIEW_IDLE_MS = 15 * 60_000;
export const PREVIEW_HEALTH_MS = 30_000;

/** Read-only toolchain: readable, and executable. Nothing under the home directory is on it. */
export const TOOLCHAIN_DIRS = ["/opt/homebrew", "/usr", "/bin", "/sbin"];
/** Readable but not executable: system frameworks and the minimum a runtime reads at start. */
const SYSTEM_READ_DIRS = ["/System", "/Library", "/private/etc", "/private/var/db", "/dev"];
const TOOLCHAIN_PATH = ["/opt/homebrew/bin", "/usr/bin", "/bin"].join(":");

const q = (p: string): string => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const sub = (dirs: string[]): string => dirs.map((d) => `(subpath ${q(d)})`).join(" ");

/** The Seatbelt profile for one workspace. Paths must already be real paths (`/tmp` is `/private/tmp`). */
export function buildProfile(opts: { workspace: string; tmp: string; toolchain?: string[] }): string {
  const toolchain = opts.toolchain ?? TOOLCHAIN_DIRS;
  const rw = [opts.workspace, opts.tmp];
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec ${sub(toolchain)})`,
    `(allow file-read* (literal "/") ${sub([...toolchain, ...SYSTEM_READ_DIRS, ...rw])})`,
    "(allow file-read-metadata)",
    `(allow file-write* (literal "/dev/null") ${sub(rw)})`,
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow signal (target self))",
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "",
  ].join("\n");
}

interface Live {
  close(): void;
}
/** Previews started by this process. */
const live = new Map<string, Live>();

/** Stops every preview this process started (daemon shutdown). */
export function stopAllPreviews(): void {
  for (const p of [...live.values()]) p.close();
}

const defaultProfileDir = (): string => path.join(os.tmpdir(), "archangel-sandbox");

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Sandboxed preview processes, found by their profile path on the command line. Level-triggered: reads the process table, not memory. */
export async function listPreviews(prefix: string, profileDir: string = defaultProfileDir()): Promise<ListedPreview[]> {
  const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = spawn("ps", ["-axo", "pid=,pgid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => resolve({ stdout: out }));
  });
  const marker = `sandbox-exec -f ${path.join(profileDir, prefix)}`;
  const found: ListedPreview[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    const at = m ? m[3]!.indexOf(marker) : -1;
    if (!m || at < 0) continue;
    const id = path.basename(m[3]!.slice(at + "sandbox-exec -f ".length).split(/\s/)[0]!, ".sb");
    found.push({ id, pgid: Number(m[2]) });
  }
  return found;
}

/**
 * Kills and marks (returns) every preview whose owner is gone: the owning process died, or it is this process and the
 * preview is no longer in memory. Another live process's previews are left alone.
 */
export async function sweepOrphanPreviews(profileDir: string = defaultProfileDir()): Promise<string[]> {
  const swept: string[] = [];
  for (const p of await listPreviews(PREVIEW_PREFIX, profileDir)) {
    const owner = Number(p.id.slice(PREVIEW_PREFIX.length).split("-")[0]);
    const orphan = !pidAlive(owner) || (owner === process.pid && !live.has(p.id));
    if (!orphan) continue;
    try {
      process.kill(-p.pgid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    fs.rmSync(path.join(profileDir, `${p.id}.sb`), { force: true });
    swept.push(p.id);
  }
  return swept;
}

function freePort(taken: Set<number>): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => (taken.has(port) ? freePort(taken).then(resolve, reject) : resolve(port)));
    });
  });
}

export interface SandboxExecOptions {
  /** Ports that must never be used, such as the dashboard's. */
  reservedPorts?: number[];
  profileDir?: string;
  idleMs?: number;
  healthMs?: number;
  killGraceMs?: number;
}

/** Workspaces come from `inner` (a throwaway clone); only running things in them is sandboxed. */
export class SandboxExecProvider implements ComputeProvider {
  private readonly profileDir: string;

  constructor(private readonly inner: Pick<ComputeProvider, "prepare" | "collect" | "destroy">, private readonly opts: SandboxExecOptions = {}) {
    this.profileDir = opts.profileDir ?? defaultProfileDir();
  }

  prepare(spec: PrepareSpec): Promise<Workspace> {
    return this.inner.prepare(spec);
  }
  collect(ws: Workspace): Promise<CollectedResult> {
    return this.inner.collect(ws);
  }
  destroy(ws: Workspace): void {
    this.inner.destroy(ws);
  }

  list(prefix: string): Promise<ListedPreview[]> {
    return listPreviews(prefix, this.profileDir);
  }

  /** Writes this run's profile and returns the argv prefix and cleanup. The tmp dir is per run and inside the sandbox's write set. */
  private sandboxed(ws: Workspace): { id: string; argv: string[]; tmp: string; cleanup: () => void } {
    const id = `${PREVIEW_PREFIX}${process.pid}-${randomBytes(4).toString("hex")}`;
    fs.mkdirSync(this.profileDir, { recursive: true });
    const workspace = fs.realpathSync(ws.path);
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archangel-sbtmp-")));
    const profile = path.join(this.profileDir, `${id}.sb`);
    fs.writeFileSync(profile, buildProfile({ workspace, tmp }));
    return {
      id,
      argv: ["-f", profile],
      tmp,
      cleanup: () => {
        fs.rmSync(profile, { force: true });
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  async exec(ws: Workspace, spec: ExecSpec): Promise<ExecResult> {
    const sb = this.sandboxed(ws);
    try {
      return await execInGroup(ws.path, { ...spec, cmd: "sandbox-exec", args: [...sb.argv, spec.cmd, ...spec.args] });
    } finally {
      sb.cleanup();
    }
  }

  async expose(ws: Workspace, spec: ExposeSpec): Promise<Exposed> {
    if (process.platform !== "darwin") throw new Error("no sandbox: sandbox-exec exists only on macOS");
    if (live.size > 0) throw new Error("a preview is already running; at most one runs at a time");
    const reserved = new Set(this.opts.reservedPorts ?? []);
    if (reserved.has(spec.port)) throw new Error(`port ${spec.port} is reserved`);
    const appPort = spec.port || (await freePort(reserved));
    if (spec.publicPort !== undefined && (reserved.has(spec.publicPort) || spec.publicPort === appPort)) throw new Error(`port ${spec.publicPort} is reserved or is the app's own`);
    const publicPort = spec.publicPort ?? (await freePort(new Set([...reserved, appPort])));
    const sb = this.sandboxed(ws);
    // Scrubbed env: the app learns its port and where to bind, and finds the toolchain. TMPDIR is the sandbox's tmp dir.
    const env = { PORT: String(appPort), HOST: "127.0.0.1", PATH: TOOLCHAIN_PATH, TMPDIR: sb.tmp };
    const child = spawn("sandbox-exec", [...sb.argv, spec.cmd, ...spec.args], { cwd: ws.path, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const s of [child.stdout, child.stderr]) s.on("data", (c: Buffer) => (output = (output + c.toString("utf8")).slice(-4000)));
    let exited = false;

    let stopped = false;
    let onClosed!: () => void;
    const closed = new Promise<void>((resolve) => (onClosed = resolve));
    const sockets = new Set<net.Socket>();
    let idleTimer: NodeJS.Timeout | undefined;
    const idleMs = spec.idleMs ?? this.opts.idleMs ?? PREVIEW_IDLE_MS;
    const proxy = net.createServer((client) => {
      armIdle();
      const upstream = net.connect(appPort, "127.0.0.1");
      for (const s of [client, upstream]) {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
        s.on("error", () => (client.destroy(), upstream.destroy()));
      }
      client.pipe(upstream).pipe(client);
    });
    const ttlTimer = setTimeout(() => close(), spec.ttlMs);
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => close(), idleMs);
    };
    const close = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(ttlTimer);
      clearTimeout(idleTimer);
      live.delete(sb.id);
      proxy.close();
      for (const s of sockets) s.destroy();
      if (!exited) killGroup(child, this.opts.killGraceMs ?? KILL_GRACE_MS);
      sb.cleanup();
      onClosed();
    };
    live.set(sb.id, { close });
    child.on("close", () => {
      exited = true;
      close();
    });
    child.on("error", () => {
      exited = true;
      close();
    });

    try {
      await this.waitReady(`http://127.0.0.1:${appPort}${spec.readyPath ?? "/"}`, () => exited || stopped, this.opts.healthMs ?? PREVIEW_HEALTH_MS, () => output);
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(publicPort, "127.0.0.1", resolve);
      });
    } catch (err) {
      close();
      throw err;
    }
    armIdle();
    return { url: `http://127.0.0.1:${publicPort}`, close, closed };
  }

  private async waitReady(url: string, gone: () => boolean, timeoutMs: number, output: () => string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      if (gone()) throw new Error(`the preview exited before it was ready:\n${output()}`);
      try {
        await fetch(url, { signal: AbortSignal.timeout(1000) });
        return;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(`the preview was not ready at ${url} within ${timeoutMs} ms (${last}):\n${output()}`);
  }
}
