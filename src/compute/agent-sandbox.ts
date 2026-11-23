import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execInGroup } from "./local.js";
import type { CollectedResult, ComputeProvider, Confine, ExecResult, ExecSpec, Exposed, ExposeSpec, InstallSpec, ListedPreview, PrepareSpec, Workspace } from "./provider.js";
import { TOOLCHAIN_DIRS } from "./sandbox-exec.js";

/**
 * Agent runs on this machine, confined by macOS Seatbelt (`compute.provider: sandbox`). The agent CLI and every command it
 * starts (the repo's tests, its build) run under one generated profile that denies by default and allows:
 *
 * - read and exec: the system toolchain, the directories on the run's PATH, the CLI's own install, the owner's extra `read` paths;
 * - read, write and exec: the workspace, the run's temp dir and caches, the owner's extra `write` paths;
 * - read and write: the CLI's own login state (`confine.state`), and the login keychain when its login lives there;
 * - the network, outbound and loopback (the CLI must reach its model; Seatbelt cannot filter by hostname).
 *
 * Nothing else under the home directory can be read: no SSH keys, no other checkouts, no `.env`. What it does NOT give, and a
 * Sail box does: the run can use the network, and it can read the one login it runs on.
 */

/** Readable, never writable: what a process reads to start, resolve names and find Apple's developer tools. */
const SYSTEM_READ_DIRS = ["/System", "/Library", "/private/etc", "/private/var/db", "/private/var/run", "/private/var/select", "/dev"];
/** Apple's command line tools (`/usr/bin/git` is a shim that execs into here). */
const DEVELOPER_DIR = "/Library/Developer";
const SECURITY_SERVICES = ["com.apple.SecurityServer", "com.apple.securityd", "com.apple.security.agent", "com.apple.security.authhost", "com.apple.securityd.xpc"];

const q = (p: string): string => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const sub = (paths: string[]): string => paths.map((p) => `(subpath ${q(p)})`).join(" ");

/** The real path of `p`, or of its nearest existing ancestor plus the rest: Seatbelt matches real paths (`/tmp` is `/private/tmp`). */
function real(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(abs) === abs) throw err;
    return path.join(real(path.dirname(abs)), path.basename(abs));
  }
}

/**
 * Where `cmd` lives, so its own files can be read: the directory of the real binary. When the PATH entry is a symlink into an
 * install's `bin` (codex's `releases/<version>/bin/codex`), the install prefix above that `bin`. Null when it is not on the PATH.
 */
function installRoot(cmd: string, searchPath: string): string | null {
  const found = (path.isAbsolute(cmd) ? [cmd] : searchPath.split(":").filter(Boolean).map((d) => path.join(d, cmd))).find((c) => fs.existsSync(c));
  if (!found) return null;
  const target = fs.realpathSync(found);
  const dir = path.dirname(target);
  return target !== path.resolve(found) && path.basename(dir) === "bin" ? path.dirname(dir) : dir;
}

export interface AgentProfileInput {
  workspace: string;
  home: string;
  /** Read and exec. */
  tools: string[];
  /** Read, write and exec. */
  scratch: string[];
  confine: Confine;
}

/** The Seatbelt profile for one agent run. Every path must already be real. A path that is the home directory or above it is dropped: nothing may open the whole home. */
export function buildAgentProfile(o: AgentProfileInput): string {
  const narrow = (paths: string[]) => [...new Set(paths)].filter((p) => p !== "/" && p !== o.home && !o.home.startsWith(`${p}/`));
  const tools = narrow([...TOOLCHAIN_DIRS, DEVELOPER_DIR, ...o.tools]);
  const scratch = narrow([o.workspace, ...o.scratch]);
  const state = narrow(o.confine.state);
  const keychains = path.join(o.home, "Library", "Keychains");
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec ${sub([...tools, ...scratch])})`,
    `(allow file-read* (literal "/") ${sub([...tools, ...SYSTEM_READ_DIRS, path.join(o.home, ".config", "git"), ...scratch, ...state])})`,
    "(allow file-read-metadata)",
    `(allow file-write* (literal "/dev/null") (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$") ${sub([...scratch, ...state])})`,
    // xcrun's lookup cache, which it keeps in the user temp dir whatever TMPDIR says (without it every /usr/bin/git call prints two errors).
    '(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db"))',
    "(allow pseudo-tty)",
    "(allow file-ioctl)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    "(allow signal (target same-sandbox))",
    "(allow network-outbound)",
    "(allow system-socket)",
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    ...(o.confine.keychain === "login" ? [`(allow file-read* file-write* ${sub([keychains])})`] : []),
    ...(o.confine.keychain === "none" ? [`(deny mach-lookup ${SECURITY_SERVICES.map((n) => `(global-name "${n}")`).join(" ")})`] : []),
    "",
  ].join("\n");
}

export interface AgentSandboxOptions {
  /** `compute.sandbox.read` and `.write`, already resolved to absolute paths. */
  read: string[];
  write: string[];
  profileDir?: string;
}

/** Workspaces come from `inner` (a throwaway clone on this machine); every command run in one is confined. */
export class AgentSandboxProvider implements ComputeProvider {
  readonly confines = true;
  private readonly profileDir: string;

  constructor(private readonly inner: ComputeProvider, private readonly opts: AgentSandboxOptions) {
    this.profileDir = opts.profileDir ?? path.join(os.tmpdir(), "archangel-sandbox");
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
  expose(ws: Workspace, spec: ExposeSpec): Promise<Exposed> {
    return this.inner.expose(ws, spec);
  }
  install(ws: Workspace, spec: InstallSpec): Promise<ExecResult> {
    return this.inner.install(ws, spec);
  }
  list(prefix: string): Promise<ListedPreview[]> {
    return this.inner.list(prefix);
  }

  async exec(ws: Workspace, spec: ExecSpec): Promise<ExecResult> {
    if (process.platform !== "darwin") throw new Error("no sandbox: sandbox-exec exists only on macOS, so compute.provider 'sandbox' cannot run here");
    const searchPath = spec.env.PATH ?? "";
    const root = installRoot(spec.cmd, searchPath);
    if (root === null) throw new Error(`${spec.cmd} is not on the run's PATH`);
    const existing = (paths: Array<string | undefined>) => paths.filter((p): p is string => Boolean(p)).map(real);
    const profile = buildAgentProfile({
      workspace: real(ws.path),
      home: real(os.homedir()),
      tools: [...existing(searchPath.split(":").filter((d) => fs.existsSync(d))), root, ...existing(this.opts.read)],
      scratch: existing([spec.env.TMPDIR, spec.env.GOCACHE, spec.env.GOMODCACHE, ...this.opts.write]),
      confine: { state: existing(spec.confine?.state ?? []), keychain: spec.confine?.keychain ?? "service" },
    });
    fs.mkdirSync(this.profileDir, { recursive: true });
    const file = path.join(this.profileDir, `archangel-agent-${process.pid}-${randomBytes(4).toString("hex")}.sb`);
    fs.writeFileSync(file, profile);
    try {
      return await execInGroup(ws.path, { ...spec, cmd: "sandbox-exec", args: ["-f", file, spec.cmd, ...spec.args] });
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
}
