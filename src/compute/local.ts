import { spawn } from "node:child_process";
import type { GitBroker } from "../broker/git-broker.js";
import { killGroup, KILL_GRACE_MS } from "../core/spawn-group.js";
import { startPeakRssPoll } from "./peak-rss.js";
import type { CollectedResult, ComputeProvider, ExecResult, ExecSpec, PrepareSpec, Workspace } from "./provider.js";

export const RSS_POLL_MS = 3000;

/**
 * Runs `spec` as a child that leads its own process group (a timeout or abort kills the whole group), streaming and
 * buffering stdout and stderr, and measuring wall time and the group's peak RSS. This is LocalProvider's exec.
 */
export function execInGroup(cwd: string, spec: ExecSpec): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(spec.cmd, spec.args, { cwd, env: spec.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killSent = false;
    const kill = () => {
      if (killSent) return;
      killSent = true;
      killGroup(child, spec.killGraceMs ?? KILL_GRACE_MS);
    };
    const poll = child.pid ? startPeakRssPoll(child.pid, spec.rssPollMs ?? RSS_POLL_MS) : null;
    const cleanup = () => {
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", kill);
    };

    spec.signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(() => {
      spec.onTimeout?.();
      kill();
    }, spec.timeoutMs);

    child.stdout.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stdout += s;
      spec.onStdout?.(s);
    });
    child.stderr.on("data", (c: Buffer) => {
      const s = c.toString("utf8");
      stderr += s;
      spec.onStderr?.(s);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      poll?.stop();
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const peakRssKb = poll?.stop() ?? null;
      cleanup();
      resolve({ code, stdout, stderr, aborted: spec.signal?.aborted ?? false, durationMs: Date.now() - startedAt, peakRssKb });
    });

    // A CLI that exits before reading its prompt closes the pipe: that surfaces as its exit code, not as an uncaught EPIPE.
    child.stdin.on("error", () => undefined);
    if (spec.stdin !== undefined) child.stdin.write(spec.stdin);
    child.stdin.end();
  });
}

/** The workspace is a throwaway clone made by the Broker on this machine; collecting hands its path to `fetchAndValidateFromClone`. */
export class LocalProvider implements ComputeProvider {
  constructor(private readonly broker: Pick<GitBroker, "createThrowawayClone" | "removeClone">) {}

  async prepare(spec: PrepareSpec): Promise<Workspace> {
    const path = await this.broker.createThrowawayClone(spec.issueNumber, spec.startSha);
    return { id: path, path };
  }

  exec(ws: Workspace, spec: ExecSpec): Promise<ExecResult> {
    return execInGroup(ws.path, spec);
  }

  async collect(ws: Workspace): Promise<CollectedResult> {
    return { kind: "clone", path: ws.path };
  }

  destroy(ws: Workspace): void {
    this.broker.removeClone(ws.path);
  }
}
