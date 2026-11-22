import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { providerToVendor, type CliProvider, type ProviderEntry } from "../config.js";
import { NOOP_LOGGER, type Logger } from "../core/logger.js";
import type { ReviewerVendor } from "../ledger/schema.js";
import type { ImplementInput, ImplementResult, Implementer } from "./implementer.js";

const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export interface ProviderCooldownStore {
  isCoolingDown(provider: CliProvider, now?: number): boolean;
  recordCooldown(provider: CliProvider, durationMs: number, reason: string, now?: number): void;
}

const RATE_LIMIT_RE =
  /rate.?limit|quota|usage.?limit|limit.?reached|too many requests|429|capacity|overloaded|try again later|exhausted/i;

export function isRateLimitOrQuotaError(text: string): boolean {
  return RATE_LIMIT_RE.test(text);
}

export interface CliExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

export type CliInvoker = (input: {
  provider: CliProvider;
  model?: string;
  cloneDir: string;
  prompt: string;
  abortController: AbortController;
  timeoutMs: number;
  goCacheDir: string;
  outputFile: string;
}) => Promise<CliExecResult>;

export interface SubscriptionImplementerOptions {
  chain: ProviderEntry[];
  transcriptsDir: string;
  invoker?: CliInvoker;
  cooldowns?: ProviderCooldownStore;
  cooldownDurationMs?: number;
  logger?: Logger;
}

function defaultCliInvoker(input: {
  provider: CliProvider;
  model?: string;
  cloneDir: string;
  prompt: string;
  abortController: AbortController;
  timeoutMs: number;
  goCacheDir: string;
  outputFile: string;
}): Promise<CliExecResult> {
  const realHome = os.homedir();
  const defaultGoModCache = process.env.GOMODCACHE ?? path.join(realHome, "go", "pkg", "mod");
  // Preserve native CLI login home so subscription OAuth works, while scrubbing GitHub/API tokens & isolating GOCACHE.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    HOME: realHome,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: path.dirname(input.goCacheDir),
    LANG: process.env.LANG ?? "en_US.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GOCACHE: input.goCacheDir,
    ...(fs.existsSync(defaultGoModCache) ? { GOMODCACHE: defaultGoModCache } : {}),
  };

  let bin: string;
  let args: string[];
  let stdinPrompt: string | null = null;

  if (input.provider === "codex") {
    bin = "codex";
    args = [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "-C",
      input.cloneDir,
      "-o",
      input.outputFile,
      ...(input.model ? ["-m", input.model] : []),
      "-",
    ];
    stdinPrompt = input.prompt;
  } else if (input.provider === "agy") {
    bin = "agy";
    args = [
      "--mode",
      "accept-edits",
      "--sandbox",
      "--disable-slash-commands",
      "--output-format",
      "json",
      ...(input.model ? ["--model", input.model] : []),
      `-p=${input.prompt}`,
    ];
  } else {
    bin = "claude";
    args = [
      "-p",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--setting-sources",
      "",
      ...(input.model ? ["--model", input.model] : []),
    ];
    stdinPrompt = input.prompt;
  }

  return new Promise<CliExecResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: input.cloneDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const killChild = () => {
      if (!child.killed) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 3000).unref();
      }
    };

    const onAbort = () => killChild();
    input.abortController.signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      input.abortController.abort(new Error(`${input.provider} attempt timed out after ${input.timeoutMs}ms`));
      killChild();
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.abortController.signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.abortController.signal.removeEventListener("abort", onAbort);
      resolve({
        code,
        stdout,
        stderr,
        aborted: input.abortController.signal.aborted,
      });
    });

    if (stdinPrompt !== null) {
      child.stdin.write(stdinPrompt);
    }
    child.stdin.end();
  });
}

function extractErrorEnvelope(stdout: string): string {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        is_error?: boolean;
        status?: string;
        error?: string | { message?: string };
        message?: string;
        result?: string;
      };
      if (obj.type === "error" || obj.is_error === true || obj.status === "ERROR") {
        if (typeof obj.error === "string") return obj.error;
        if (obj.error && typeof obj.error.message === "string") return obj.error.message;
        if (typeof obj.message === "string") return obj.message;
        if (typeof obj.result === "string") return obj.result;
      }
      // Only inspect the final JSON object; never scan arbitrary command/test output lines (Opus B2).
      return "";
    } catch {
      return "";
    }
  }
  return "";
}

function hasWorkspaceEdits(cloneDir: string): boolean {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: cloneDir, encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}

function captureWorkspaceContinuityContext(cloneDir: string): string {
  try {
    const status = execFileSync("git", ["status", "--short"], { cwd: cloneDir, encoding: "utf8" }).trim();
    const diffStat = execFileSync("git", ["diff", "--stat"], { cwd: cloneDir, encoding: "utf8" }).trim();
    const recentCommits = execFileSync("git", ["log", "-n", "3", "--oneline"], {
      cwd: cloneDir,
      encoding: "utf8",
    }).trim();
    return [
      "--- CONTINUITY HANDOFF CONTEXT (previous provider hit rate/quota limit) ---",
      `Recent commits:\n${recentCommits || "(none)"}`,
      `Uncommitted status:\n${status || "(clean)"}`,
      `Uncommitted diff stat:\n${diffStat || "(none)"}`,
      "Continue cleanly from this working tree state and finish committing the fix.",
      "--- END CONTINUITY CONTEXT ---",
    ].join("\n");
  } catch {
    return "Previous provider hit a rate/quota limit. Continue cleanly from the current workspace.";
  }
}

function extractSummary(provider: CliProvider, stdout: string, outputFile: string): string {
  if (provider === "codex" && fs.existsSync(outputFile)) {
    const text = fs.readFileSync(outputFile, "utf8").trim();
    if (text) return text.slice(0, 4000);
  }
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { response?: string; result?: string };
      if (typeof parsed.response === "string" && parsed.response.trim()) return parsed.response.trim().slice(0, 4000);
      if (typeof parsed.result === "string" && parsed.result.trim()) return parsed.result.trim().slice(0, 4000);
    } catch {
      // Ignore non-JSON lines
    }
  }
  return `Completed implement attempt via ${provider}.`;
}

/**
 * Subscription-backed CLI Implementer with Paseo Continuity-style automatic failover:
 * - Primary: `codex` (ChatGPT Plus/Pro subscription via `codex exec --sandbox workspace-write`).
 * - Fallback: `agy` (Antigravity subscription) or `claude` when primary hits rate/quota limits.
 * - Preserves workspace progress across failovers by injecting Continuity git context.
 */
export class SubscriptionImplementer implements Implementer {
  private readonly chain: ProviderEntry[];
  private readonly transcriptsDir: string;
  private readonly invoker: CliInvoker;
  private readonly cooldowns?: ProviderCooldownStore;
  private readonly cooldownDurationMs: number;
  private readonly logger: Logger;

  constructor(opts: SubscriptionImplementerOptions) {
    if (opts.chain.length === 0) {
      throw new Error("SubscriptionImplementer requires at least one provider in chain");
    }
    this.chain = opts.chain;
    this.transcriptsDir = opts.transcriptsDir;
    this.invoker = opts.invoker ?? defaultCliInvoker;
    this.cooldowns = opts.cooldowns;
    this.cooldownDurationMs = opts.cooldownDurationMs ?? DEFAULT_COOLDOWN_MS;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  async run(input: ImplementInput): Promise<ImplementResult> {
    fs.mkdirSync(this.transcriptsDir, { recursive: true });
    const transcriptPath = path.join(
      this.transcriptsDir,
      `issue-${input.issueNumber}-${Date.now()}.jsonl`,
    );
    const attemptTemp = fs.mkdtempSync(path.join(os.tmpdir(), `archangel-sub-impl-${input.issueNumber}-`));
    const goCacheDir = path.join(attemptTemp, "gocache");
    fs.mkdirSync(goCacheDir, { recursive: true });

    const providersUsed: ReviewerVendor[] = [];
    const errors: string[] = [];

    // Reorder chain so providers currently in rate-limit cooldown are tried last (Continuity cooldown memory).
    const now = Date.now();
    const healthy = this.chain.filter((e) => !this.cooldowns?.isCoolingDown(e.provider, now));
    const cooling = this.chain.filter((e) => this.cooldowns?.isCoolingDown(e.provider, now));
    const orderedChain = healthy.length > 0 ? [...healthy, ...cooling] : this.chain;

    try {
      for (let i = 0; i < orderedChain.length; i++) {
        const entry = orderedChain[i]!;
        const outputFile = path.join(attemptTemp, `last-${i}-${entry.provider}.txt`);
        const prompt =
          i === 0
            ? input.prompt
            : `${captureWorkspaceContinuityContext(input.cloneDir)}\n\n${input.prompt}`;

        this.logger.info(
          "implementer/provider_start",
          `Running ${entry.provider}${entry.model ? ` (${entry.model})` : ""}${i > 0 ? " [Continuity failover]" : ""}`,
          { issue: input.issueNumber },
        );

        fs.appendFileSync(
          transcriptPath,
          `${JSON.stringify({ event: "provider_start", index: i, provider: entry.provider, model: entry.model ?? null, ts: Date.now() })}\n`,
        );

        const res = await this.invoker({
          provider: entry.provider,
          model: entry.model,
          cloneDir: input.cloneDir,
          prompt,
          abortController: input.abortController,
          timeoutMs: input.timeoutMs,
          goCacheDir,
          outputFile,
        });

        const extractedSummary = extractSummary(entry.provider, res.stdout, outputFile);
        fs.appendFileSync(
          transcriptPath,
          `${JSON.stringify({
            event: "provider_end",
            provider: entry.provider,
            code: res.code,
            aborted: res.aborted,
            summary: extractedSummary.slice(0, 1000),
            stderr: res.stderr.slice(0, 4000),
            ts: Date.now(),
          })}\n`,
        );

        if (res.aborted) {
          return {
            summary: "Aborted",
            costUsd: 0,
            transcriptPath,
            aborted: true,
            providersUsed,
          };
        }

        if (res.code === 0) {
          const vendor = providerToVendor(entry.provider);
          if (!providersUsed.includes(vendor)) providersUsed.push(vendor);
          return {
            summary: `[${entry.provider}] ${extractedSummary}`,
            costUsd: 0,
            transcriptPath,
            aborted: false,
            providersUsed,
          };
        }

        // Only inspect stderr + final error envelope — never match test output on stdout (Opus B2).
        const errorSignal = `${res.stderr}\n${extractErrorEnvelope(res.stdout)}`.trim();
        const isQuota = isRateLimitOrQuotaError(errorSignal);
        errors.push(`${entry.provider} (exit ${res.code}): ${(errorSignal || res.stdout).slice(0, 300)}`);

        // If this provider actually mutated the workspace before failing over, record it so it cannot review its own partial code (Opus B1).
        if (hasWorkspaceEdits(input.cloneDir)) {
          const vendor = providerToVendor(entry.provider);
          if (!providersUsed.includes(vendor)) providersUsed.push(vendor);
        }

        // Continuity failover: record cooldown + move to the next configured subscription provider!
        if (isQuota) {
          this.cooldowns?.recordCooldown(entry.provider, this.cooldownDurationMs, errorSignal.slice(0, 200));
          if (i + 1 < orderedChain.length) {
            this.logger.warn(
              "implementer/continuity_failover",
              `${entry.provider} hit rate/quota limit (cooling down ${Math.round(this.cooldownDurationMs / 60_000)}m) -> failing over to ${orderedChain[i + 1]!.provider}`,
              { issue: input.issueNumber },
            );
            fs.appendFileSync(
              transcriptPath,
              `${JSON.stringify({
                event: "continuity_failover",
                from: entry.provider,
                to: orderedChain[i + 1]!.provider,
                reason: "rate_limit_or_quota",
                ts: Date.now(),
              })}\n`,
            );
            continue;
          }
        }

        throw new Error(errors.join(" | "));
      }

      throw new Error(`All fallback subscription providers exhausted: ${errors.join(" | ")}`);
    } finally {
      fs.rmSync(attemptTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}
