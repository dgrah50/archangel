import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliProviderSchema, providerToPaseo, type ArchangelConfig } from "../config.js";
import { tryParseJson } from "../core/json.js";
import type { GitBroker } from "../broker/git-broker.js";
import { renderRecapComment } from "../core/recap.js";
import { sha256 } from "../core/reconciler.js";
import { extractPrFromPhase, stepPhase } from "../core/thread-machine.js";
import type { GitHubClient } from "../github/client.js";
import type { Ledger } from "../ledger/store.js";

const execFileAsync = promisify(execFile);

const STOPPED_PASEO_STATUSES = new Set(["idle", "stopped", "finished", "completed", "archived", "error"]);

export interface PaseoRunner {
  checkoutBranchAndSeed(input: {
    branchName: string;
    title: string;
    prompt: string;
    /** Paseo `--provider` value, `provider` or `provider/model`; omitted for Paseo's default agent. */
    provider?: string;
    themeLabel: string | null;
    repoDir?: string;
  }): Promise<{ agentId: string; workspaceId: string | null }>;
  isAgentRunning(agentId: string): Promise<boolean>;
}

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
    provider?: string;
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
    if (input.provider) {
      args.push("--provider", input.provider);
    }
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

    if (workspaceId && input.themeLabel) {
      try {
        const { createPaseoClient } = await import("@getpaseo/client");
        const rawHost = this.host ?? "127.0.0.1:6767";
        const url =
          rawHost.startsWith("ws://") || rawHost.startsWith("wss://")
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
      } catch (_err) {
        // Non-fatal: CLI agent labels are already applied even if workspace label RPC is unavailable.
        void _err;
      }
    }

    return { agentId, workspaceId };
  }

  async isAgentRunning(agentId: string): Promise<boolean> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("paseo", [...this.baseArgs(), "inspect", agentId, "--json"], { maxBuffer: 2 * 1024 * 1024 }));
    } catch (err) {
      // Only a definite "no such agent" counts as stopped. A Paseo daemon that is down, a timeout or any other failure is UNKNOWN,
      // and an unknown agent must never read as "not running" (resume would run beside a Paseo agent that is still pushing).
      const e = err as { message?: string; stderr?: string };
      if (/not found|no such|unknown agent|\b404\b/i.test(`${e.message ?? ""} ${e.stderr ?? ""}`)) return false;
      throw new Error(`Could not verify whether Paseo agent ${agentId} is running: ${(e.stderr || e.message || String(err)).slice(0, 200)}`);
    }
    const raw = tryParseJson(stdout);
    if (!raw.ok || typeof raw.value !== "object" || raw.value === null) {
      throw new Error(`Could not read the state of Paseo agent ${agentId} (unparseable inspect output)`);
    }
    const parsed = raw.value as { Status?: string; status?: string; Archived?: boolean };
    if (parsed.Archived) return false;
    const st = String(parsed.Status ?? parsed.status ?? "").toLowerCase();
    return !STOPPED_PASEO_STATUSES.has(st);
  }
}

export interface HandoffDeps {
  config: ArchangelConfig;
  ledger: Ledger;
  github: GitHubClient;
  broker: GitBroker;
  paseo: PaseoRunner;
  localRepoDir?: string;
  daemonWaitTimeoutMs?: number;
}

export async function handoffThreadToPaseo(
  issueNumber: number,
  deps: HandoffDeps,
): Promise<{ branchName: string; agentId: string; workspaceId: string | null }> {
  let thread = deps.ledger.getThread(issueNumber);
  if (!thread) {
    throw new Error(`Thread #${issueNumber} not found in Ledger`);
  }

  const now = Date.now();
  if (deps.ledger.isDaemonActive(deps.config.staleLeaseMs, now)) {
    const cmdId = deps.ledger.enqueueCommand(issueNumber, "handoff", now);
    const waitMs = deps.daemonWaitTimeoutMs ?? 30_000;
    let outcome = await waitForCommand(deps.ledger, cmdId, now + waitMs);
    if (outcome.kind === "pending") {
      // Give up only by cancelling: that succeeds only if the daemon has NOT claimed the command, so it can never later park the
      // Thread as owner_driving behind our back. If it already claimed it, it is mid-handoff: wait for it to finish.
      if (deps.ledger.cancelCommand(cmdId, "CLI timed out waiting for the daemon to claim the handoff")) {
        throw new Error("Timed out waiting for live Archangel daemon to claim the handoff; nothing was changed");
      }
      outcome = await waitForCommand(deps.ledger, cmdId, Date.now() + waitMs);
    }
    if (outcome.kind === "failed") throw new Error(`Daemon handoff command failed: ${outcome.error}`);
    if (outcome.kind !== "completed") {
      throw new Error("The daemon claimed the handoff but did not finish it in time; Paseo was not launched. Check `archangel status` and retry.");
    }
    thread = deps.ledger.getThread(issueNumber)!;
  } else {
    await deps.github.addLabels(issueNumber, [deps.config.labels.paused]);
    const stepped = stepPhase(
      thread.phase,
      thread.mode,
      { t: "handoff_started", paseoAgentId: null, paseoWorkspaceId: null, now },
      { issueNumber, title: thread.title, needsYouLabel: deps.config.labels.needsYou },
    );
    if (!stepped.ok) {
      throw new Error(`Cannot hand off Thread #${issueNumber}: ${stepped.reject}`);
    }
    const updated = deps.ledger.transition(issueNumber, thread.version, stepped.next, {
      nextMode: stepped.nextMode,
      effects: stepped.effects,
      auditTopic: "handoff/started",
      now,
    });
    if (!updated) {
      throw new Error(`Concurrent modification while handing off Thread #${issueNumber}`);
    }
    thread = updated;
  }

  const pr = extractPrFromPhase(thread.phase);
  const reviews = pr ? deps.ledger.getReviewsForSha(issueNumber, pr.headSha) : [];
  const recap = renderRecapComment({
    thread,
    reviews,
    blockers: [{ code: "paused", message: "Handed off to owner in Paseo" }],
  });

  const attempts = deps.ledger.listAttemptsFor(issueNumber);
  const failed = attempts.findLast((a) => a.status === "failed");
  const writer = attempts.findLast((a) => CliProviderSchema.safeParse(a.provider).success);
  const provider = writer
    ? `${providerToPaseo(CliProviderSchema.parse(writer.provider))}${writer.model ? `/${writer.model}` : ""}`
    : undefined;
  const context = [
    failed ? `Latest failed Attempt${failed.errorCategory ? ` (${failed.errorCategory})` : ""}: ${(failed.errorMessage ?? "no message").slice(0, 500)}` : null,
    attempts.at(-1)?.transcriptPath ? `Transcript of the latest Attempt: ${attempts.at(-1)!.transcriptPath}` : null,
  ].filter((l): l is string => l !== null);

  const launched = await deps.paseo.checkoutBranchAndSeed({
    branchName: thread.branchName,
    title: `Archangel #${issueNumber}: ${thread.title}`,
    themeLabel: thread.themeLabel,
    repoDir: deps.localRepoDir,
    provider,
    prompt: [
      `Taking over Archangel Thread #${issueNumber} on branch \`${thread.branchName}\`.`,
      "Review the latest recap and findings below, then await my instructions:",
      "",
      recap,
      ...(context.length ? ["", ...context] : []),
    ].join("\n"),
  });

  if (thread.phase.kind === "owner_driving") {
    const attached = stepPhase(
      thread.phase,
      thread.mode,
      {
        t: "paseo_attached",
        paseoAgentId: launched.agentId || null,
        paseoWorkspaceId: launched.workspaceId,
      },
      { issueNumber, title: thread.title, needsYouLabel: deps.config.labels.needsYou },
    );
    if (!attached.ok) {
      throw new Error(`Cannot attach Paseo agent to Thread #${issueNumber}: ${attached.reject}`);
    }
    const updated = deps.ledger.transition(issueNumber, thread.version, attached.next, {
      auditTopic: "handoff/paseo_launched",
      auditPayload: { ...launched, provider: provider ?? null },
    });
    if (!updated) {
      throw new Error(`Concurrent modification while attaching Paseo agent to Thread #${issueNumber}`);
    }
  }

  return {
    branchName: thread.branchName,
    agentId: launched.agentId,
    workspaceId: launched.workspaceId,
  };
}

export async function resumeThreadFromPaseo(
  issueNumber: number,
  deps: Pick<HandoffDeps, "config" | "ledger" | "github" | "paseo">,
): Promise<{ headSha: string | null }> {
  const thread = deps.ledger.getThread(issueNumber);
  if (!thread) {
    throw new Error(`Thread #${issueNumber} not found in Ledger`);
  }
  if (thread.phase.kind !== "owner_driving") {
    throw new Error(
      `Thread #${issueNumber} is in phase '${thread.phase.kind}', not 'owner_driving'. Use 'archangel retry ${issueNumber}' to clear needs_you.`,
    );
  }
  if (thread.phase.paseoAgentId) {
    const running = await deps.paseo.isAgentRunning(thread.phase.paseoAgentId);
    if (running) {
      throw new Error(
        `Paseo agent ${thread.phase.paseoAgentId} is still running; stop it before resuming Archangel.`,
      );
    }
  }

  const issue = await deps.github.getIssue(issueNumber);
  const pr = await deps.github.findPrByHeadBranch(thread.branchName);
  let headSha: string | null = pr?.headSha ?? null;
  if (!headSha) {
    headSha = await deps.github.getBranchTipSha(thread.branchName).catch(() => null);
  }
  if (headSha) {
    deps.ledger.recordPushedSha(headSha, issueNumber, "owner_resume");
  }

  await deps.github.removeLabel(issueNumber, deps.config.labels.paused);
  await deps.github.removeLabel(issueNumber, deps.config.labels.needsYou);

  const now = Date.now();
  const stepped = stepPhase(
    thread.phase,
    thread.mode,
    {
      t: "owner_resume",
      pr: pr ? { prNumber: pr.number, headSha: pr.headSha, baseSha: pr.baseSha } : null,
      now,
    },
    { issueNumber, title: thread.title, needsYouLabel: deps.config.labels.needsYou },
  );
  if (!stepped.ok) {
    throw new Error(`Resume transition rejected: ${stepped.reject}`);
  }

  const updated = deps.ledger.transition(issueNumber, thread.version, stepped.next, {
    nextMode: stepped.nextMode ?? "advisory",
    bodySha256: sha256(issue.body),
    auditTopic: "handoff/resumed",
    auditPayload: { headSha },
    now,
  });
  if (!updated) {
    throw new Error(`Concurrent modification while resuming Thread #${issueNumber}`);
  }

  return { headSha };
}

type CommandOutcome = { kind: "pending" } | { kind: "claimed" } | { kind: "completed" } | { kind: "failed"; error: string } | { kind: "cancelled" };

async function waitForCommand(ledger: Ledger, id: number, deadline: number): Promise<CommandOutcome> {
  for (;;) {
    const s = ledger.getCommand(id)?.state;
    if (s?.kind === "completed") return { kind: "completed" };
    if (s?.kind === "failed") return { kind: "failed", error: s.error };
    if (s?.kind === "cancelled") return { kind: "cancelled" };
    if (Date.now() >= deadline) return { kind: s?.kind === "claimed" ? "claimed" : "pending" };
    await new Promise((r) => setTimeout(r, 250));
  }
}
