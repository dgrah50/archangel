import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ComputeProvider, Workspace } from "../compute/provider.js";
import { PREVIEW_TTL_MS } from "../compute/sandbox-exec.js";
import type { Ledger } from "../ledger/store.js";
import { ingestImage } from "./pitch-ingest.js";
import { screenshotUrl } from "../compute/browser-shots.js";
import { Preview } from "./workflow.js";

/**
 * Running a built PoC. Dependencies are installed at build time, OUTSIDE the sandbox, because Seatbelt cannot allow registry hosts
 * for one step. The preview itself then runs the installed workspace under the sandbox provider only. `expose` throws on a provider
 * with no sandbox, and nothing is written to the Ledger until it has returned, so a preview never starts unsandboxed.
 * The URL lives in the runner's memory. Its port is derived from the issue number so the dashboard can link to it without storing it.
 */

export type WebPreview = Extract<Preview, { kind: "web" }>;

const PORT_BASE = 31000;
const PORT_SPAN = 20000;
export const pocPreviewPort = (issueNumber: number): number => PORT_BASE + (issueNumber % PORT_SPAN);
export const pocPreviewUrl = (issueNumber: number): string => `http://127.0.0.1:${pocPreviewPort(issueNumber)}`;

/** Where a build's installed workspace is kept so a preview can start without installing again. */
export const pocWorkspaceDir = (dataDir: string, repo: string, issueNumber: number): string => path.join(dataDir, "poc-workspaces", `${repo.replace("/", "__")}-${issueNumber}`);

/** The repo's `preview` block from its cached, already-resolved workflow; null when absent or the workflow is not ok. */
export function cachedWebPreview(ledger: Ledger, repo: string): WebPreview | null {
  const wf = ledger.listCachedWorkflows().find((c) => c.repo === repo)?.workflow as { status?: string; preview?: unknown } | null | undefined;
  const parsed = wf?.status === "ok" && wf.preview != null ? Preview.safeParse(wf.preview) : null;
  return parsed?.success && parsed.data.kind === "web" ? parsed.data : null;
}

/** Runs the repo's declared install in `ws` with a scrubbed environment and no inherited credentials, like the repo setup script. */
export async function installPreviewDeps(compute: Pick<ComputeProvider, "exec">, ws: Workspace, install: string[], timeoutMs: number): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-install-home-"));
  try {
    const res = await compute.exec(ws, {
      cmd: install[0]!,
      args: install.slice(1),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin", HOME: home, TMPDIR: home, LANG: "en_US.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", CI: "1" },
      timeoutMs,
    });
    if (res.code !== 0) throw new Error(`install exited ${res.code}: ${res.stderr.slice(-300)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

export interface PocPreviewDeps {
  ledger: Ledger;
  broker: { resolveRef(ref: string): Promise<string> };
  /** Prepares and installs (outside any sandbox). */
  local: Pick<ComputeProvider, "prepare" | "exec" | "destroy">;
  /** Runs the app. Must be a sandboxing provider. */
  sandbox: ComputeProvider;
  preview: WebPreview;
  dataDir: string;
  installTimeoutMs: number;
  /** Takes one PNG of a loopback URL; defaults to the sandboxed browser. */
  screenshot?: (url: string) => Promise<Buffer>;
}

export interface RunningPreview {
  url: string;
  expiresAt: number;
  close(): void;
  /** Settles after the Ledger says `stopped`. */
  closed: Promise<void>;
}

/** The pages to capture: `readyPath` first, then the policy's extra pages, at most 3 in all. */
export const shotPaths = (p: WebPreview): string[] => [...new Set([p.readyPath, ...p.shots])].slice(0, 3);

export async function startPocPreview(deps: PocPreviewDeps, issueNumber: number, now = Date.now()): Promise<RunningPreview> {
  const { ledger, preview } = deps;
  const poc = ledger.getPoc(issueNumber);
  if (!poc || (poc.state.kind !== "ready" && poc.state.kind !== "stopped")) throw new Error(`pitch #${issueNumber} has no built PoC to preview (state: ${poc?.state.kind ?? "none"})`);
  const headSha = await deps.broker.resolveRef(poc.ref);

  const dir = pocWorkspaceDir(deps.dataDir, ledger.repo, issueNumber);
  let ws: Workspace = { id: dir, path: dir };
  if (!fs.existsSync(dir)) {
    // The build could not keep its installed workspace: clone the ref and install again, still outside the sandbox.
    const fresh = await deps.local.prepare({ issueNumber, startSha: headSha });
    try {
      await installPreviewDeps(deps.local, fresh, preview.install, deps.installTimeoutMs);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.renameSync(fresh.path, dir);
    } finally {
      deps.local.destroy(fresh);
    }
    ws = { id: dir, path: dir };
  }

  const [cmd, ...args] = preview.start;
  const exposed = await deps.sandbox.expose(ws, { port: preview.port, publicPort: pocPreviewPort(issueNumber), ttlMs: PREVIEW_TTL_MS, cmd: cmd!, args, readyPath: preview.readyPath });
  const expiresAt = now + PREVIEW_TTL_MS;
  const started = ledger.stepPocState(issueNumber, { t: "preview_started", at: now, expiresAt });
  if (!started.ok) {
    exposed.close();
    throw new Error(started.reject);
  }
  ledger.appendAudit("poc/started", issueNumber, "archangel", { expiresAt }, now);

  let byOwner = false;
  const closed = exposed.closed.then(() => {
    const at = Date.now();
    const reason = byOwner ? "owner" : at >= expiresAt - 1000 ? "ttl" : "idle";
    ledger.stepPocState(issueNumber, { t: "preview_stopped", reason, at }, {}, at);
    ledger.appendAudit("poc/stopped", issueNumber, "archangel", { reason }, at);
  });

  await captureShots(deps, issueNumber, headSha, exposed.url).catch((err: unknown) => {
    ledger.appendAudit("poc/shots_failed", issueNumber, "archangel", { detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) }, Date.now());
  });
  return { url: exposed.url, expiresAt, close: () => ((byOwner = true), exposed.close()), closed };
}

/** Screenshots go through the same ingest as every image (sniffed, bounded, re-encoded) before the Ledger or the dashboard sees them. */
async function captureShots(deps: PocPreviewDeps, issueNumber: number, headSha: string, url: string): Promise<void> {
  const shoot = deps.screenshot ?? screenshotUrl;
  const shots: Array<{ page: string; png: Awaited<ReturnType<typeof ingestImage>> }> = [];
  for (const page of shotPaths(deps.preview)) {
    shots.push({ page, png: await ingestImage(await shoot(`${url}${page}`), deps.dataDir) });
  }
  deps.ledger.clearPitchCaptures(issueNumber);
  for (const { page, png } of shots) {
    deps.ledger.recordPitchAttachment({ issueNumber, kind: "capture", caption: `Page ${page}`, source: `${page}@${headSha}`, ...png });
  }
}

/** A `running` row whose runner vanished (a crash, a reboot) is closed once its expiry has passed. */
export function closeStalePreviews(ledger: Ledger, now: number): void {
  for (const p of ledger.listPocs()) {
    if (p.repo === ledger.repo && p.state.kind === "running" && p.state.expiresAt <= now) {
      ledger.stepPocState(p.issueNumber, { t: "preview_stopped", reason: "restart", at: now }, {}, now);
    }
  }
}
