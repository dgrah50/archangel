import { execFileSync, spawn } from "node:child_process";
import { killGroup } from "../core/spawn-group.js";
import fs from "node:fs";
import os from "node:os";
import { tryParseJson } from "../core/json.js";
import path from "node:path";
import { DEFAULT_ACCOUNTS, accountEnv, accountsFor, providerToVendor, type Account, type Chains, type CliProvider, type ProviderEntry, type WriterRole } from "../config.js";
import { ACCOUNT_COOLDOWN_MS, MAX_ACCOUNT_SWITCHES, NO_ACCOUNT_STATE, selectAccount, type AccountLedger } from "../core/accounts.js";
import { NOOP_LOGGER, type Logger } from "../core/logger.js";
import type { ReviewerVendor } from "../ledger/schema.js";
import type { ImplementInput, ImplementResult, Implementer } from "./implementer.js";

// Real quota signals only: stderr can carry arbitrary tool or test output ("foo_test.go:429:", "memory exhausted"),
// so a bare number or word is not enough. Known shapes: "HTTP 429: usage limit reached", "429 Too Many Requests",
// "You've hit your usage limit", "5-hour limit reached", "rate_limit_error", "overloaded_error", "RESOURCE_EXHAUSTED",
// "Quota exceeded for quota metric".
const RATE_LIMIT_RE = new RegExp(
  [
    String.raw`rate[ _-]?limit`,
    String.raw`usage[ _-]?limit`,
    String.raw`limit[ _-]?reached`,
    String.raw`hit your (?:usage |rate )?limit`,
    String.raw`too many requests`,
    String.raw`\bquota\b`,
    String.raw`resource[ _]exhausted`,
    String.raw`overloaded_error`,
    String.raw`(?:http|status(?: code)?|error|code)[ :=]*429\b`,
    String.raw`\b429[ :]+(?:too many|rate|quota|usage)`,
    String.raw`\b(?:overloaded|capacity|exhausted)\b[^\n]{0,40}\b(?:rate|quota|usage|limit|try again)`,
    String.raw`\b(?:rate|quota|usage|limit)\b[^\n]{0,40}\b(?:overloaded|capacity|exhausted)\b`,
  ].join("|"),
  "i",
);

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
  /** The login this run uses (its home is passed to the CLI); absent means the CLI's default home. */
  account?: Account;
  cloneDir: string;
  prompt: string;
  abortController: AbortController;
  timeoutMs: number;
  goCacheDir: string;
  outputFile: string;
}) => Promise<CliExecResult>;

export interface SubscriptionImplementerOptions {
  /** Provider chain per writing role; an Attempt uses the chain of its role. */
  chains: Pick<Chains, WriterRole>;
  accounts?: Account[];
  transcriptsDir: string;
  invoker?: CliInvoker;
  /** Per-account cooldowns, usage counters and readings; without it nothing cools down and selection is config order. */
  accountState?: AccountLedger;
  cooldownDurationMs?: number;
  logger?: Logger;
}

function defaultCliInvoker(input: {
  provider: CliProvider;
  model?: string;
  account?: Account;
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
    // The one passthrough for a second login: this account's config dir (nothing else from the host env).
    ...accountEnv(input.account),
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
      "auto",
      "--sandbox",
      "--dangerously-skip-permissions",
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
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    let killSent = false;
    const killChild = () => {
      if (killSent) return;
      killSent = true;
      killGroup(child, 3000);
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

    // A CLI that exits before reading its prompt closes the pipe: that surfaces as its exit code, not as an uncaught EPIPE.
    child.stdin.on("error", () => undefined);
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
    const parsed = tryParseJson(line);
    if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return "";
    const obj = parsed.value as {
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
    return "";
  }
  return "";
}

function mayHaveMutated(cloneDir: string, headBefore: string | null): boolean {
  try {
    if (execFileSync("git", ["status", "--porcelain"], { cwd: cloneDir, encoding: "utf8" }).trim().length > 0) return true;
    return headBefore === null || execFileSync("git", ["rev-parse", "HEAD"], { cwd: cloneDir, encoding: "utf8" }).trim() !== headBefore;
  } catch (_err) {
    // Fail closed: an uninspectable workspace may have been mutated, so the vendor must stay disqualified from reviewing.
    return true;
  }
}

function headSha(cloneDir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: cloneDir, encoding: "utf8" }).trim();
  } catch (_err) {
    return null;
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
  } catch (err) {
    return `Previous provider hit a rate/quota limit (${err instanceof Error ? err.message : String(err)}). Continue cleanly from the current workspace.`;
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
    const res = tryParseJson(line);
    if (!res.ok || typeof res.value !== "object" || res.value === null) continue;
    const parsed = res.value as { response?: string; result?: string };
    if (typeof parsed.response === "string" && parsed.response.trim()) return parsed.response.trim().slice(0, 4000);
    if (typeof parsed.result === "string" && parsed.result.trim()) return parsed.result.trim().slice(0, 4000);
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
  private readonly chains: Pick<Chains, WriterRole>;
  private readonly accounts: Account[];
  private readonly transcriptsDir: string;
  private readonly invoker: CliInvoker;
  private readonly state: AccountLedger;
  private readonly cooldownDurationMs: number;
  private readonly logger: Logger;

  constructor(opts: SubscriptionImplementerOptions) {
    for (const role of ["implement", "revise", "rebase"] as const) {
      if (opts.chains[role].length === 0) throw new Error(`SubscriptionImplementer requires at least one provider in the ${role} chain`);
    }
    this.chains = opts.chains;
    this.accounts = opts.accounts ?? DEFAULT_ACCOUNTS;
    this.transcriptsDir = opts.transcriptsDir;
    this.invoker = opts.invoker ?? defaultCliInvoker;
    this.state = opts.accountState ?? NO_ACCOUNT_STATE;
    this.cooldownDurationMs = opts.cooldownDurationMs ?? ACCOUNT_COOLDOWN_MS;
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

    const chain: ProviderEntry[] = this.chains[input.role];
    // Prefer vendors that already implemented this thread, while retaining configured order within each group.
    const preferred = input.preferVendors?.length
      ? chain.filter((e) => input.preferVendors!.includes(providerToVendor(e.provider)))
      : [];
    const remaining = input.preferVendors?.length
      ? chain.filter((e) => !input.preferVendors!.includes(providerToVendor(e.provider)))
      : chain;
    const preferredChain = [...preferred, ...remaining];
    const now = Date.now();
    // Entries with a selectable account (not cooling, under their daily cap) run first, in order. When none has one,
    // cooldowns are ignored (caps are not) and the chain is tried as ordered, exactly as before accounts existed.
    const healthy = preferredChain.filter((e) => selectAccount(accountsFor(this.accounts, e), this.state, now) !== null);
    const ignoreCooldown = healthy.length === 0;
    const orderedChain = ignoreCooldown ? preferredChain : [...healthy, ...preferredChain.filter((e) => !healthy.includes(e))];

    // Same-vendor failover first: on a limit error the next account of the same entry runs before the next entry, and at most
    // MAX_ACCOUNT_SWITCHES switches happen in one Attempt.
    const tried = new Set<string>();
    let switches = 0;
    let runIndex = 0;

    try {
      for (const entry of orderedChain) {
        for (;;) {
          const account = selectAccount(accountsFor(this.accounts, entry), this.state, Date.now(), { exclude: tried, ignoreCooldown });
          if (!account) break; // no account left on this entry: next entry
          tried.add(account.id);
          const i = runIndex++;
          const outputFile = path.join(attemptTemp, `last-${i}-${entry.provider}.txt`);
          const prompt = i === 0 ? input.prompt : `${captureWorkspaceContinuityContext(input.cloneDir)}\n\n${input.prompt}`;
          const label = `${entry.provider}${entry.model ? ` (${entry.model})` : ""} [${account.id}]`;

          this.logger.info("implementer/provider_start", `Running ${label}${i > 0 ? " [Continuity failover]" : ""}`, { issue: input.issueNumber });
          fs.appendFileSync(
            transcriptPath,
            `${JSON.stringify({ event: "provider_start", index: i, provider: entry.provider, model: entry.model ?? null, account: account.id, ts: Date.now() })}\n`,
          );

          const headBefore = headSha(input.cloneDir);
          const res = await this.invoker({
            provider: entry.provider,
            model: entry.model,
            account,
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
              account: account.id,
              code: res.code,
              aborted: res.aborted,
              summary: extractedSummary.slice(0, 1000),
              stderr: res.stderr.slice(0, 4000),
              ts: Date.now(),
            })}\n`,
          );

          if (res.aborted) {
            return { summary: "Aborted", costUsd: 0, transcriptPath, aborted: true, providersUsed };
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
              runBy: { provider: entry.provider, model: entry.model ?? null, accountId: account.id },
            };
          }

          // Only inspect stderr + final error envelope, never match test output on stdout (Opus B2).
          const errorSignal = `${res.stderr}\n${extractErrorEnvelope(res.stdout)}`.trim();
          const isQuota = isRateLimitOrQuotaError(errorSignal);
          errors.push(`${label} (exit ${res.code}): ${(errorSignal || res.stdout).slice(0, 300)}`);

          // If this provider actually mutated the workspace before failing over, record it so it cannot review its own partial code (Opus B1).
          // Uncommitted edits OR new commits both count: implementers are asked to commit their work.
          if (mayHaveMutated(input.cloneDir, headBefore)) {
            const vendor = providerToVendor(entry.provider);
            if (!providersUsed.includes(vendor)) providersUsed.push(vendor);
          }

          if (!isQuota) throw new Error(errors.join(" | "));

          // Continuity failover: cool this account down, then move on (same vendor's next account, else the next entry).
          this.state.recordCooldown(account.id, this.cooldownDurationMs, errorSignal.slice(0, 200));
          switches++;
          if (switches > MAX_ACCOUNT_SWITCHES) {
            throw new Error(`account switch limit (${MAX_ACCOUNT_SWITCHES}) reached after rate/quota limits: ${errors.join(" | ")}`);
          }
          this.logger.warn(
            "implementer/continuity_failover",
            `${label} hit rate/quota limit (cooling down ${Math.round(this.cooldownDurationMs / 60_000)}m) -> switching (${switches}/${MAX_ACCOUNT_SWITCHES})`,
            { issue: input.issueNumber },
          );
          fs.appendFileSync(
            transcriptPath,
            `${JSON.stringify({ event: "continuity_failover", from: account.id, switches, reason: "rate_limit_or_quota", ts: Date.now() })}\n`,
          );
        }
      }

      throw new Error(`All fallback subscription providers exhausted: ${errors.join(" | ")}`);
    } finally {
      fs.rmSync(attemptTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}
