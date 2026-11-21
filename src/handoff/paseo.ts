import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArchangelConfig } from "../config.js";
import type { GitBroker } from "../broker/git-broker.js";
import type { GitHubClient } from "../github/client.js";
import type { Ledger } from "../ledger/store.js";
import { renderRecapComment } from "../core/recap.js";

const execFileAsync = promisify(execFile);

export interface PaseoRunner {
  checkoutBranchAndSeed(input: {
    branchName: string;
    title: string;
    prompt: string;
    themeLabel: string | null;
    repoDir?: string;
  }): Promise<{ agentId: string; workspaceId: string | null }>;
  isAgentRunning(agentId: string): Promise<boolean>;
}

/**
 * Default Paseo CLI runner + optional `@getpaseo/client` workspace-label assignment.
 */
export class PaseoCliRunner implements PaseoRunner {
  private readonly host?: string;
  private readonly home?: string;

  constructor(opts: { host?: string; home?: string } = {}) {
    this.host = opts.host;
    this.home = opts.home;
  }

  private baseArgs(): string[] {
    const args: string[] = [];
    if (this.host) args.push("--host", this.host);
    if (this.home) args.push("--home", this.home);
    return args;
  }

  async checkoutBranchAndSeed(input: {
    branchName: string;
    title: string;
    prompt: string;
    themeLabel: string | null;
    repoDir?: string;
  }): Promise<{ agentId: string; workspaceId: string | null }> {
    const args = [
      ...this.baseArgs(),
      "run",
      "--no-wait",
      "--json",
      "--title",
      input.title,
      "--new-workspace",
      "worktree",
      "--worktree-mode",
      "checkout-branch",
      "--branch",
      input.branchName,
      "--label",
      "origin=archangel",
    ];
    if (input.themeLabel) {
      args.push("--label", `theme=${input.themeLabel}`);
    }
    if (input.repoDir) {
      args.push("--cwd", input.repoDir);
    }
    args.push(input.prompt);

    const { stdout } = await execFileAsync("paseo", args, { maxBuffer: 5 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as { id?: string; agentId?: string; workspaceId?: string };
    const agentId = parsed.id ?? parsed.agentId ?? "";
    const workspaceId = parsed.workspaceId ?? null;

    // Best-effort UI workspace label via @getpaseo/client if workspaceId and themeLabel are known.
    if (workspaceId && input.themeLabel) {
      try {
        const { createPaseoClient } = await import("@getpaseo/client");
        const rawHost = this.host ?? "127.0.0.1:6767";
        const url = rawHost.startsWith("ws://") || rawHost.startsWith("wss://")
          ? rawHost
          : `ws://${rawHost}`;
        const client = createPaseoClient({ url });
        await client.connect();
        try {
          const ws = client.workspaces.ref(workspaceId);
          await ws.setLabel(input.themeLabel, { assigned: true });
        } finally {
          await client.close();
        }
      } catch {
        // Non-fatal: CLI agent labels are already applied even if workspace label RPC is unavailable.
      }
    }

    return { agentId, workspaceId };
  }

  async isAgentRunning(agentId: string): Promise<boolean> {
    const { stdout } = await execFileAsync(
      "paseo",
      [...this.baseArgs(), "inspect", agentId, "--json"],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { Status?: string; status?: string };
    const st = String(parsed.Status ?? parsed.status ?? "").toLowerCase();
    return st === "running" || st === "working" || st === "busy";
  }
}

export interface HandoffDeps {
  config: ArchangelConfig;
  ledger: Ledger;
  github: GitHubClient;
  broker: GitBroker;
  paseo: PaseoRunner;
  activeAbort?: AbortController;
  activeCloneDir?: string;
  localRepoDir?: string;
}

/**
 * Transfers active ownership of a factory Thread to Paseo (ADR-0006):
 * 1. Aborts any in-flight Claude Agent SDK Attempt via AbortController.
 * 2. Fetches & pushes any unpushed factory commits via the Broker and deletes the throwaway clone.
 * 3. Applies `factory:paused` on GitHub and updates Ledger state to `paused`.
 * 4. Launches Paseo on `factory/<issue>` with Theme label and latest Recap + findings.
 */
export async function handoffThreadToPaseo(
  issueNumber: number,
  deps: HandoffDeps,
): Promise<{ branchName: string; agentId: string; workspaceId: string | null }> {
  const thread = deps.ledger.getThread(issueNumber);
  if (!thread) {
    throw new Error(`Thread #${issueNumber} not found in Ledger`);
  }

  // 1. Abort running step if any.
  if (deps.activeAbort && !deps.activeAbort.signal.aborted) {
    deps.activeAbort.abort(new Error("Owner requested handoff to Paseo"));
  }

  // 2. Push any unpushed commits from active throwaway clone via Broker, then remove clone.
  const remoteUrl = await deps.github.getRemoteUrlWithToken();
  await deps.broker.ensureBareRepo(remoteUrl);
  if (deps.activeCloneDir) {
    try {
      const mainSha = await deps.github.getBranchTipSha(deps.config.defaultBranch);
      const val = await deps.broker.fetchAndValidateFromClone(
        deps.activeCloneDir,
        issueNumber,
        mainSha,
      );
      if (val.protectedViolations.length === 0) {
        await deps.broker.pushFactoryBranch(thread.branchName, val.headSha, remoteUrl);
        deps.ledger.recordPushedSha(val.headSha, issueNumber, "broker");
        deps.ledger.updateThread(issueNumber, { headSha: val.headSha });
      }
    } finally {
      deps.broker.removeClone(deps.activeCloneDir);
    }
  }

  // 3. Pause factory autonomy on GitHub + Ledger.
  await deps.github.addLabels(issueNumber, [deps.config.labels.paused]);
  const updated = deps.ledger.updateThread(issueNumber, {
    state: "paused",
    postHandoff: true,
  });

  const reviews = updated.headSha
    ? deps.ledger.getReviewsForSha(issueNumber, updated.headSha)
    : [];
  const recap = renderRecapComment({
    thread: updated,
    reviews,
    blockers: [{ code: "paused", message: "Handed off to owner in Paseo" }],
  });

  // 4. Launch Paseo worktree seeded with Recap.
  const launched = await deps.paseo.checkoutBranchAndSeed({
    branchName: updated.branchName,
    title: `Archangel #${issueNumber}: ${updated.title}`,
    themeLabel: updated.themeLabel,
    repoDir: deps.localRepoDir,
    prompt: [
      `Taking over Archangel Thread #${issueNumber} on branch \`${updated.branchName}\`.`,
      "Review the latest recap and findings below, then await my instructions:",
      "",
      recap,
    ].join("\n"),
  });

  deps.ledger.updateThread(issueNumber, {
    paseoAgentId: launched.agentId || null,
    paseoWorkspaceId: launched.workspaceId,
  });
  deps.ledger.appendAudit("handoff/started", issueNumber, "owner", launched);

  return {
    branchName: updated.branchName,
    agentId: launched.agentId,
    workspaceId: launched.workspaceId,
  };
}

/**
 * Resumes advisory Gate + Review tracking after owner finishes in Paseo (ADR-0006):
 * - Verifies Paseo session is stopped (prevents two active owners).
 * - Pins the owner-authorized head SHA in `pushed_shas` (`owner_resume`).
 * - Clears `factory:paused` and keeps `postHandoff = true` (owner merges manually in v0).
 */
export async function resumeThreadFromPaseo(
  issueNumber: number,
  deps: Pick<HandoffDeps, "config" | "ledger" | "github" | "paseo">,
): Promise<{ headSha: string }> {
  const thread = deps.ledger.getThread(issueNumber);
  if (!thread) {
    throw new Error(`Thread #${issueNumber} not found in Ledger`);
  }
  if (thread.paseoAgentId) {
    const running = await deps.paseo.isAgentRunning(thread.paseoAgentId);
    if (running) {
      throw new Error(
        `Paseo agent ${thread.paseoAgentId} is still running; stop it before resuming Archangel.`,
      );
    }
  }

  const headSha = await deps.github.getBranchTipSha(thread.branchName);
  deps.ledger.recordPushedSha(headSha, issueNumber, "owner_resume");
  await deps.github.removeLabel(issueNumber, deps.config.labels.paused);
  deps.ledger.updateThread(issueNumber, {
    state: "awaiting_gate",
    headSha,
    postHandoff: true,
    gateWaitStartedAt: Date.now(),
    needsYouReason: null,
  });
  deps.ledger.appendAudit("handoff/resumed", issueNumber, "owner", { headSha });
  return { headSha };
}
