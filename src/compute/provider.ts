/**
 * Where an Attempt's untrusted work runs. Today only LocalProvider exists (a throwaway clone and a child process on
 * this machine); a remote ephemeral-VM provider plugs into the same four calls. The caller builds the env and the
 * argv; the provider never sees a credential it was not handed.
 */

/** A prepared workspace. `id` is the provider's handle (idempotent destroy keys on it); `path` is where commands run. */
export interface Workspace {
  id: string;
  path: string;
}

export interface PrepareSpec {
  issueNumber: number;
  /** The commit (or unpushed staging ref) the workspace starts at. */
  startSha: string;
  /** The default branch tip the Attempt works against. A remote workspace gets it as a ref named after the default branch, as a local clone has. */
  baseSha?: string;
}

export interface ExecSpec {
  cmd: string;
  args: string[];
  /** The whole environment of the command; nothing is inherited from the host. */
  env: NodeJS.ProcessEnv;
  /** Written to the command's stdin, then closed. */
  stdin?: string;
  timeoutMs: number;
  /** Aborting kills the command's whole process group. */
  signal?: AbortSignal;
  /** SIGTERM-to-SIGKILL grace for the group kill. */
  killGraceMs?: number;
  /** Called when the timeout fires, just before the group is killed. */
  onTimeout?: () => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Peak-RSS poll interval; default 3000. */
  rssPollMs?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when `signal` was aborted by the time the command ended. */
  aborted: boolean;
  durationMs: number;
  /** Peak summed RSS of the command's process tree in KB; null when no sample was taken. */
  peakRssKb: number | null;
}

/** What the Broker validates and fetches. A remote provider returns a bundle path instead of a clone path. */
export type CollectedResult =
  | { kind: "clone" | "bundle"; path: string }
  /** The Attempt added no commits: HEAD is the start. The Broker validates `startSha` as an unchanged clone. */
  | { kind: "empty"; startSha: string };

/** What `expose` runs and how long it may live. */
export interface ExposeSpec {
  /** The port the app listens on (given to it as PORT); 0 picks a random free loopback port. */
  port: number;
  /** The loopback port the URL is served on; a random free one when absent. Lets a caller derive the URL without storing it. */
  publicPort?: number;
  /** Hard lifetime from start. */
  ttlMs: number;
  /** Stop after this long without a connection; the provider's default when absent. */
  idleMs?: number;
  /** The command that starts the app, run in the workspace. */
  cmd: string;
  args: string[];
  /** Polled for a response before `expose` resolves; default "/". */
  readyPath?: string;
}

/** A dependency install, run only by a provider that can sandbox it. */
export interface InstallSpec {
  /** The repo's declared install command as an argv. */
  argv: string[];
  timeoutMs: number;
  /** Owner policy (`preview.allowInstallScripts`): let lifecycle scripts run, still inside the sandbox. Default false. */
  allowScripts?: boolean;
}

/** A running preview. The URL and handle live in daemon memory only, never in the Ledger. */
export interface Exposed {
  url: string;
  /** Idempotent: stops the app's whole process group. */
  close(): void;
  /** Settles when the preview has stopped, for any reason (close, TTL, idle, the app exiting). */
  closed: Promise<void>;
}

/** A preview process found by `list`. */
export interface ListedPreview {
  id: string;
  /** Process group id. */
  pgid: number;
}

export interface ComputeProvider {
  /** True when the workspace is on another machine: host credentials must never be passed to `exec`, and the workspace path does not exist here. */
  readonly remote?: boolean;
  prepare(spec: PrepareSpec): Promise<Workspace>;
  /** Rejects only when the command cannot be started; a non-zero exit, a timeout and an abort are results. */
  exec(ws: Workspace, spec: ExecSpec): Promise<ExecResult>;
  collect(ws: Workspace): Promise<CollectedResult>;
  /** Safe to call twice, and on a workspace that never finished preparing. */
  destroy(ws: Workspace): void;
  /** Runs the app in the workspace and makes it reachable on a loopback URL. A provider with no sandbox throws. */
  expose(ws: Workspace, spec: ExposeSpec): Promise<Exposed>;
  /** Installs dependencies in the workspace under a sandbox profile with registry network. A provider with no sandbox throws; there is no unsandboxed install. */
  install(ws: Workspace, spec: InstallSpec): Promise<ExecResult>;
  /** Preview processes whose id starts with `prefix`, for the orphan sweep. */
  list(prefix: string): Promise<ListedPreview[]>;
}
