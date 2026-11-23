import { AGY_PLACEHOLDER_ENV, AGY_TOKEN_FILE } from "../compute/agy-broker-adapter.js";
import { CODEX_PLACEHOLDER_ENV } from "../compute/codex-broker-adapter.js";
import type { ComputeProvider, ExecSpec, Workspace } from "../compute/provider.js";
import fs from "node:fs";
import os from "node:os";
import { tryParseJson } from "../core/json.js";
import path from "node:path";
import { DEFAULT_ACCOUNTS, accountEnv, accountsFor, providerToVendor, type Account, type Chains, type CliProvider, type ProviderEntry, type WriterRole } from "../config.js";
import { ACCOUNT_COOLDOWN_MS, MAX_ACCOUNT_SWITCHES, NO_ACCOUNT_STATE, selectAccount, type AccountLedger } from "../core/accounts.js";
import { NOOP_LOGGER, type Logger } from "../core/logger.js";
import { AttemptError, type AttemptErrorCategory, type ReviewerVendor } from "../ledger/schema.js";
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

/** Why a CLI run failed, from stderr and the CLI's own final result envelope only. `quota` is handled by account failover. */
export type CliFailureReason = "quota" | "provider_network" | "auth" | "context_overflow" | "permission_denied" | "model_unavailable" | "unknown";

// Numeric statuses need a keyword and non-alphanumeric boundaries so "foo_test.go:429", "15290ms" and "c429f4b" never match.
const CONTEXT_RE = /prompt is too long|context[ _-]?(?:length|window)[^\n]{0,40}(?:exceed|too long|limit)|exceeds? (?:the )?(?:maximum )?context|maximum context length/i;
const AUTH_RE =
  /not logged in|please (?:run )?\/?login|invalid (?:api key|token|credentials)|(?:expired|revoked) (?:token|credentials|session|login)|authentication[ _]?(?:failed|error|required)|(?:http|status(?: code)?|error|code)[ :=]*40[13](?![A-Za-z0-9])/i;
const NETWORK_RE =
  /econnreset|etimedout|econnrefused|enotfound|socket hang up|connection (?:reset|closed|was closed|lost|error)|network (?:error|is unreachable)|stream (?:closed|disconnected|error)|(?:http|status(?: code)?|error|code)[ :=]*5\d\d(?![A-Za-z0-9])|internal server error|bad gateway|service unavailable|gateway time-?out/i;
const DENIED_RE = /auto-denied|permission[^\n]{0,40}headless mode cannot prompt/i;
// The login cannot run the model a chain entry names: codex "The 'x' model is not supported when using Codex with a ChatGPT account",
// claude "There's an issue with the selected model (x). It may not exist or you may not have access to it", an API not_found_error for "model: x".
const MODEL_RE = /model[^\n]{0,80}(?:is not supported|does not exist|is not available|may not exist)|issue with the selected model|not_found_error[^\n]{0,60}model|(?:unknown|invalid|unsupported) model/i;

function finalResult(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split("\n").at(-1)?.trim();
  if (!line?.startsWith("{")) return null;
  const parsed = tryParseJson(line);
  return parsed.ok && typeof parsed.value === "object" && parsed.value !== null ? (parsed.value as Record<string, unknown>) : null;
}

/** Classifies a non-zero exit. Test output on stdout is never inspected: only stderr and the final error envelope. */
export function classifyCliFailure(run: { stdout: string; stderr: string }): CliFailureReason {
  const signal = `${run.stderr}\n${extractErrorEnvelope(run.stdout)}`;
  if (isRateLimitOrQuotaError(signal)) return "quota";
  if (finalResult(run.stdout)?.terminal_reason === "prompt_too_long" || CONTEXT_RE.test(signal)) return "context_overflow";
  if (AUTH_RE.test(signal)) return "auth";
  if (DENIED_RE.test(run.stderr)) return "permission_denied";
  if (MODEL_RE.test(signal)) return "model_unavailable";
  if (NETWORK_RE.test(signal)) return "provider_network";
  return "unknown";
}

/**
 * A run that exited 0 but did not work: Claude ended its turn for a reason other than `completed`, or a tool was denied in headless
 * mode. Only when the workspace is untouched, so real work is never turned into a failure.
 */
function exitZeroFailure(run: { stdout: string; stderr: string }, mutated: boolean): CliFailureReason | null {
  const result = finalResult(run.stdout);
  if (result?.terminal_reason === "prompt_too_long") return "context_overflow";
  if (mutated) return null;
  const denials = result?.permission_denials;
  if ((Array.isArray(denials) && denials.length > 0) || DENIED_RE.test(run.stderr)) return "permission_denied";
  if (typeof result?.terminal_reason === "string" && result.terminal_reason !== "completed") return "unknown";
  return null;
}

const FAILURE_CATEGORY: Record<CliFailureReason, AttemptErrorCategory> = {
  quota: "quota",
  provider_network: "provider_network",
  auth: "auth",
  context_overflow: "context_overflow",
  permission_denied: "permission_denied",
  model_unavailable: "model_unavailable",
  unknown: "implementer_failed",
};

/** One automatic retry of the same account after a network drop, per Attempt. */
export const NETWORK_RETRY_WAIT_MS = 5_000;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface CliExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  /** Wall time and peak process-tree RSS (KB) of the run; absent from test fakes. */
  durationMs?: number;
  peakRssKb?: number | null;
}

export type CliInvoker = (input: {
  provider: CliProvider;
  model?: string;
  /** The login this run uses (its home is passed to the CLI); absent means the CLI's default home. */
  account?: Account;
  compute: ComputeProvider;
  workspace: Workspace;
  prompt: string;
  abortController: AbortController;
  timeoutMs: number;
  goCacheDir: string;
  outputFile: string;
  /** Remote codex on a broker-held ChatGPT login: the synthetic login the box gets is for this account. Absent means codex uses the API-key placeholder. */
  brokerAccountId?: string;
  /** Remote agy on a broker-held Google login: the box gets a synthetic login file instead of API-key settings. */
  agyBrokered?: boolean;
}) => Promise<CliExecResult>;

export interface SubscriptionImplementerOptions {
  /** Provider chain per writing role; an Attempt uses the chain of its role. */
  chains: Pick<Chains, WriterRole>;
  accounts?: Account[];
  /** Providers whose entries run on the remote box (they have a remote credential configured); every other entry runs locally. Placement is per entry, never a failover. */
  remoteProviders?: ReadonlySet<CliProvider>;
  /** Set when remote codex runs on a broker-held ChatGPT login. Called before the box is prepared with the longest the Attempt may run; it throws to refuse the Attempt, else returns the (non-secret) account id. */
  codexBrokerPreflight?: (attemptMs: number) => { accountId: string };
  /** Set when remote agy runs on a broker-held Google login. Same contract as codexBrokerPreflight: throws to refuse the Attempt. */
  agyBrokerPreflight?: (attemptMs: number) => void;
  transcriptsDir: string;
  invoker?: CliInvoker;
  /** Per-account cooldowns, usage counters and readings; without it nothing cools down and selection is config order. */
  accountState?: AccountLedger;
  cooldownDurationMs?: number;
  networkRetryWaitMs?: number;
  logger?: Logger;
}

const REMOTE_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * The login a box's codex gets for a brokered ChatGPT account: the access token is only the placeholder (the egress policy swaps in
 * the real one on chatgpt.com), the id_token is unsigned (its signature is never checked) with synthetic claims, the refresh token is a dummy and `last_refresh` is
 * now, so codex neither refreshes nor can (auth.openai.com is unreachable). The JSON holds no single quote, so single quotes are safe.
 */
function syntheticCodexLogin(accountId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId)) throw new Error("the broker's ChatGPT account id has an unexpected shape");
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const idToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({ email: "broker@archangel.invalid", exp: Math.floor(Date.now() / 1000) + 365 * 86_400, "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_user_id: "user-broker", chatgpt_account_id: accountId } })}.c2ln`;
  const json = `{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"${idToken}","access_token":"'"$${CODEX_PLACEHOLDER_ENV}"'","refresh_token":"not-a-refresh-token","account_id":"${accountId}"},"last_refresh":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}`;
  return `mkdir -p "$HOME/.codex" && printf '%s' '${json}' > "$HOME/.codex/auth.json"`;
}

/** agy only runs on an API key when its settings say so. The key itself is the placeholder GEMINI_API_KEY the egress policy provides. */
const AGY_REMOTE_SETTINGS = '{"modelProvider":"gemini"}';

/**
 * The login a box's agy gets for a brokered Google account: agy keeps its login in this file when no keyring is usable (a box has no
 * D-Bus). The access token is only the placeholder (the egress policy swaps in the real one on the Cloud Code hosts), the refresh token is
 * a dummy and the expiry is far off, so agy neither refreshes nor can (oauth2.googleapis.com is unreachable).
 */
const SYNTHETIC_AGY_LOGIN = `mkdir -p "$HOME/${path.posix.dirname(AGY_TOKEN_FILE)}" && printf '%s' '{"token":{"access_token":"'"$${AGY_PLACEHOLDER_ENV}"'","token_type":"Bearer","refresh_token":"not-a-refresh-token","expiry":"2099-01-01T00:00:00Z","expires_in":3599},"auth_method":"consumer","id_token_email":"broker@archangel.invalid"}' > "$HOME/${AGY_TOKEN_FILE}" && chmod 600 "$HOME/${AGY_TOKEN_FILE}"`;

function remoteEnv(): NodeJS.ProcessEnv {
  return {
    PATH: REMOTE_PATH,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    DISABLE_TELEMETRY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

function localEnv(input: { account?: Account; goCacheDir: string }): NodeJS.ProcessEnv {
  const realHome = os.homedir();
  const defaultGoModCache = process.env.GOMODCACHE ?? path.join(realHome, "go", "pkg", "mod");
  // Preserve native CLI login home so subscription OAuth works, while scrubbing GitHub/API tokens & isolating GOCACHE.
  return {
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
}

async function defaultCliInvoker(input: {
  provider: CliProvider;
  model?: string;
  account?: Account;
  compute: ComputeProvider;
  workspace: Workspace;
  prompt: string;
  abortController: AbortController;
  timeoutMs: number;
  goCacheDir: string;
  outputFile: string;
  brokerAccountId?: string;
  agyBrokered?: boolean;
}): Promise<CliExecResult> {
  // A remote box gets no host env at all: its only login is the placeholder CLAUDE_CODE_OAUTH_TOKEN the egress policy provides.
  const env: NodeJS.ProcessEnv = input.compute.remote ? remoteEnv() : localEnv(input);
  const cloneDir = input.workspace.path;

  let bin: string;
  let args: string[];
  let stdinPrompt: string | null = null;

  if (input.provider === "codex") {
    bin = "codex";
    args = [
      "exec",
      "--sandbox",
      // codex's workspace-write sandbox mounts .git read-only, so a rebase or commit cannot run. A box is already the isolation boundary.
      input.compute.remote ? "danger-full-access" : "workspace-write",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--json",
      "-C",
      cloneDir,
      // The last-message file is a path on this machine; a box has no way to hand it back.
      ...(input.compute.remote ? [] : ["-o", input.outputFile]),
      ...(input.brokerAccountId ? ["-c", 'cli_auth_credentials_store="file"'] : []),
      ...(input.model ? ["-m", input.model] : []),
      "-",
    ];
    stdinPrompt = input.prompt;
  } else if (input.provider === "agy") {
    bin = "agy";
    args = [
      "--mode",
      "auto",
      // agy's terminal sandbox is dropped in a box for the same reason as codex's.
      ...(input.compute.remote ? [] : ["--sandbox"]),
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

  if (input.compute.remote) {
    // Inside the box the provider logs in with the placeholder key the egress policy minted, never a host login: codex reads it as
    // CODEX_API_KEY, agy needs its settings file. Both wrappers `exec` the CLI so stdin and exit codes pass through.
    if (input.provider === "codex") {
      const login = input.brokerAccountId ? syntheticCodexLogin(input.brokerAccountId) : 'export CODEX_API_KEY="$OPENAI_API_KEY"';
      [bin, args] = ["bash", ["-c", `${login} && exec "$@"`, "bash", bin, ...args]];
    }
    if (input.provider === "agy") {
      const login = input.agyBrokered ? SYNTHETIC_AGY_LOGIN : `mkdir -p "$HOME/.gemini/antigravity-cli" && printf %s '${AGY_REMOTE_SETTINGS}' > "$HOME/.gemini/antigravity-cli/settings.json"`;
      [bin, args] = ["bash", ["-c", `${login} && exec "$@"`, "bash", bin, ...args]];
    }
  }

  const { abortController, provider, timeoutMs } = input;
  const res = await input.compute.exec(input.workspace, {
    cmd: bin,
    args,
    env,
    stdin: stdinPrompt ?? undefined,
    timeoutMs,
    signal: abortController.signal,
    killGraceMs: 3000,
    onTimeout: () => abortController.abort(new Error(`${provider} attempt timed out after ${timeoutMs}ms`)),
  });
  return { code: res.code, stdout: res.stdout, stderr: res.stderr, aborted: res.aborted, durationMs: res.durationMs, peakRssKb: res.peakRssKb };
}

/** Per-file cap on a run's kept CLI output, so a runaway CLI cannot fill the disk. */
const MAX_RUN_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Writes a run's full CLI output beside the Attempt transcript; over the cap it is cut with a marker. */
function writeRunOutput(file: string, text: string): string {
  const bytes = Buffer.from(text);
  const kept = bytes.length > MAX_RUN_OUTPUT_BYTES ? `${bytes.subarray(0, MAX_RUN_OUTPUT_BYTES).toString()}\n[truncated: ${bytes.length - MAX_RUN_OUTPUT_BYTES} more bytes]\n` : text;
  fs.writeFileSync(file, kept);
  return file;
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
    if (obj.type === "error" || obj.type === "turn.failed" || obj.is_error === true || obj.status === "ERROR") {
      if (typeof obj.error === "string") return obj.error;
      if (obj.error && typeof obj.error.message === "string") return obj.error.message;
      if (typeof obj.message === "string") return obj.message;
      if (typeof obj.result === "string") return obj.result;
    }
    return "";
  }
  return "";
}

/** Runs git in the Attempt's workspace through its provider; stdout, or a throw on a non-zero exit. */
async function gitIn(input: { compute: ComputeProvider; workspace: Workspace }, args: string[]): Promise<string> {
  const res = await input.compute.exec(input.workspace, {
    cmd: "git",
    args,
    env: { PATH: input.compute.remote ? REMOTE_PATH : (process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    timeoutMs: 60_000,
  });
  if (res.code !== 0) throw new Error(`git ${args[0]} exited ${res.code}: ${res.stderr.trim().slice(-200)}`);
  return res.stdout.trim();
}

type WorkspaceInput = { compute: ComputeProvider; workspace: Workspace };

async function mayHaveMutated(input: WorkspaceInput, headBefore: string | null): Promise<boolean> {
  try {
    if ((await gitIn(input, ["status", "--porcelain"])).length > 0) return true;
    return headBefore === null || (await gitIn(input, ["rev-parse", "HEAD"])) !== headBefore;
  } catch (_err) {
    // Fail closed: an uninspectable workspace may have been mutated, so the vendor must stay disqualified from reviewing.
    return true;
  }
}

async function headSha(input: WorkspaceInput): Promise<string | null> {
  try {
    return await gitIn(input, ["rev-parse", "HEAD"]);
  } catch (_err) {
    return null;
  }
}

async function captureWorkspaceContinuityContext(input: WorkspaceInput): Promise<string> {
  try {
    const status = await gitIn(input, ["status", "--short"]);
    const diffStat = await gitIn(input, ["diff", "--stat"]);
    const recentCommits = await gitIn(input, ["log", "-n", "3", "--oneline"]);
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
  private readonly remoteProviders: ReadonlySet<CliProvider>;
  private readonly codexBrokerPreflight: SubscriptionImplementerOptions["codexBrokerPreflight"];
  private readonly agyBrokerPreflight: SubscriptionImplementerOptions["agyBrokerPreflight"];
  private readonly transcriptsDir: string;
  private readonly invoker: CliInvoker;
  private readonly state: AccountLedger;
  private readonly cooldownDurationMs: number;
  private readonly networkRetryWaitMs: number;
  private readonly logger: Logger;

  constructor(opts: SubscriptionImplementerOptions) {
    for (const role of ["implement", "revise", "rebase"] as const) {
      if (opts.chains[role].length === 0) throw new Error(`SubscriptionImplementer requires at least one provider in the ${role} chain`);
    }
    this.chains = opts.chains;
    this.accounts = opts.accounts ?? DEFAULT_ACCOUNTS;
    this.remoteProviders = opts.remoteProviders ?? new Set();
    this.codexBrokerPreflight = opts.codexBrokerPreflight;
    this.agyBrokerPreflight = opts.agyBrokerPreflight;
    this.transcriptsDir = opts.transcriptsDir;
    this.invoker = opts.invoker ?? defaultCliInvoker;
    this.state = opts.accountState ?? NO_ACCOUNT_STATE;
    this.cooldownDurationMs = opts.cooldownDurationMs ?? ACCOUNT_COOLDOWN_MS;
    this.networkRetryWaitMs = opts.networkRetryWaitMs ?? NETWORK_RETRY_WAIT_MS;
    this.logger = opts.logger ?? NOOP_LOGGER;
  }

  private agyBrokerCheck(attemptMs: number): void {
    try {
      this.agyBrokerPreflight!(attemptMs);
    } catch (err) {
      throw new AttemptError("auth", err instanceof Error ? err.message : String(err));
    }
  }

  private async brokerAccount(attemptMs: number): Promise<string> {
    try {
      return this.codexBrokerPreflight!(attemptMs).accountId;
    } catch (err) {
      throw new AttemptError("auth", err instanceof Error ? err.message : String(err));
    }
  }

  async run(input: ImplementInput): Promise<ImplementResult> {
    fs.mkdirSync(this.transcriptsDir, { recursive: true });
    const transcriptPath = path.join(
      this.transcriptsDir,
      `issue-${input.issueNumber}-${Date.now()}.jsonl`,
    );
    const runOutputBase = transcriptPath.replace(/\.jsonl$/, "");
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
    let networkRetried = false;
    let runIndex = 0;
    let durationMs = 0;
    let peakRssKb: number | undefined;
    const measured = () => ({ durationMs, ...(peakRssKb === undefined ? {} : { peakRssKb }) });

    try {
      for (const entry of orderedChain) {
        for (;;) {
          const account = selectAccount(accountsFor(this.accounts, entry), this.state, Date.now(), { exclude: tried, ignoreCooldown });
          if (!account) break; // no account left on this entry: next entry
          tried.add(account.id);
          const i = runIndex++;
          const outputFile = path.join(attemptTemp, `last-${i}-${entry.provider}.txt`);
          const label = `${entry.provider}${entry.model ? ` (${entry.model})` : ""} [${account.id}]`;
          const runBy = { provider: entry.provider, model: entry.model ?? null, accountId: account.id };

          this.logger.info("implementer/provider_start", `Running ${label}${i > 0 ? " [Continuity failover]" : ""}`, { repo: input.repo, issue: input.issueNumber });
          fs.appendFileSync(
            transcriptPath,
            `${JSON.stringify({ event: "provider_start", index: i, provider: entry.provider, model: entry.model ?? null, account: account.id, ts: Date.now() })}\n`,
          );

          // Placement is by configured credential, never failover: a provider with a remote credential (injected on the wire) runs on the remote box; the rest keep their local logins.
          const ranOn: "local" | "remote" = this.remoteProviders.has(entry.provider) && input.workspaces.remote ? "remote" : "local";
          const handle = input.workspaces[ranOn]!;
          // A brokered login is checked before any box exists: a failed or soon-to-expire token refuses the Attempt, never falls back.
          const brokerAccountId = ranOn === "remote" && entry.provider === "codex" && this.codexBrokerPreflight ? await this.brokerAccount(input.timeoutMs) : undefined;
          const agyBrokered = ranOn === "remote" && entry.provider === "agy" && this.agyBrokerPreflight !== undefined;
          if (agyBrokered) this.agyBrokerCheck(input.timeoutMs);
          const placed = { compute: handle.compute, workspace: await handle.workspace() };
          const prompt = i === 0 ? input.prompt : `${await captureWorkspaceContinuityContext(placed)}\n\n${input.prompt}`;
          const headBefore = await headSha(placed);
          const res = await this.invoker({
            provider: entry.provider,
            model: entry.model,
            account,
            ...placed,
            prompt,
            abortController: input.abortController,
            timeoutMs: input.timeoutMs,
            goCacheDir,
            outputFile,
            brokerAccountId,
            agyBrokered,
          }).catch((err: unknown) => {
            if ((err as NodeJS.ErrnoException)?.code === "ENOENT") throw new AttemptError("cli_missing", `${label}: \`${entry.provider}\` is not installed or not on PATH`, runBy);
            throw err;
          });

          durationMs += res.durationMs ?? 0;
          if (res.peakRssKb != null) peakRssKb = Math.max(peakRssKb ?? 0, res.peakRssKb);
          const extractedSummary = extractSummary(entry.provider, res.stdout, outputFile);
          const runOutputFile = `${runOutputBase}.${i}-${entry.provider}`;
          const stdoutPath = writeRunOutput(`${runOutputFile}.stdout`, res.stdout);
          const stderrPath = writeRunOutput(`${runOutputFile}.stderr`, res.stderr);
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
              stdoutPath,
              stderrPath,
              ts: Date.now(),
            })}\n`,
          );

          if (res.aborted) {
            return { summary: "Aborted", costUsd: 0, transcriptPath, aborted: true, providersUsed, ranOn, ...measured() };
          }

          const mutated = await mayHaveMutated(placed, headBefore);
          const reason = res.code === 0 ? exitZeroFailure(res, mutated) : classifyCliFailure(res);

          if (reason === null) {
            const vendor = providerToVendor(entry.provider);
            if (!providersUsed.includes(vendor)) providersUsed.push(vendor);
            return {
              summary: `[${entry.provider}] ${extractedSummary}`,
              costUsd: 0,
              transcriptPath,
              aborted: false,
              providersUsed,
              ranOn,
              runBy,
              ...measured(),
            };
          }

          // Only inspect stderr + final error envelope, never match test output on stdout (Opus B2).
          const errorSignal = `${res.stderr}\n${extractErrorEnvelope(res.stdout)}`.trim();
          errors.push(`${label} (exit ${res.code}, ${reason}): ${(errorSignal || res.stdout).slice(0, 300)}`);

          // If this provider actually mutated the workspace before failing over, record it so it cannot review its own partial code (Opus B1).
          // Uncommitted edits OR new commits both count: implementers are asked to commit their work.
          if (mutated) {
            const vendor = providerToVendor(entry.provider);
            if (!providersUsed.includes(vendor)) providersUsed.push(vendor);
          }

          // A network drop gets one retry of the same account per Attempt; anything else that is not quota fails now.
          if (reason === "provider_network" && !networkRetried) {
            networkRetried = true;
            fs.appendFileSync(
              transcriptPath,
              `${JSON.stringify({ event: "network_retry", account: account.id, waitMs: this.networkRetryWaitMs, ts: Date.now() })}\n`,
            );
            await abortableSleep(this.networkRetryWaitMs, input.abortController.signal);
            if (input.abortController.signal.aborted) return { summary: "Aborted", costUsd: 0, transcriptPath, aborted: true, providersUsed, ranOn, ...measured() };
            tried.delete(account.id);
            continue;
          }
          if (reason === "auth" && brokerAccountId) {
            // A 401 on a brokered login is never retried by moving tokens around: the broker's token expired or was revoked.
            throw new AttemptError("auth", `remote codex login rejected (the broker's token expired or was revoked; not retried): ${errors.join(" | ")}`, runBy);
          }
          if (reason !== "quota") throw new AttemptError(FAILURE_CATEGORY[reason], errors.join(" | "), runBy);

          // Continuity failover: cool this account down, then move on (same vendor's next account, else the next entry).
          this.state.recordCooldown(account.id, this.cooldownDurationMs, errorSignal.slice(0, 200));
          switches++;
          if (switches > MAX_ACCOUNT_SWITCHES) {
            throw new AttemptError("quota", `account switch limit (${MAX_ACCOUNT_SWITCHES}) reached after rate/quota limits: ${errors.join(" | ")}`, runBy);
          }
          this.logger.warn(
            "implementer/continuity_failover",
            `${label} hit rate/quota limit (cooling down ${Math.round(this.cooldownDurationMs / 60_000)}m) -> switching (${switches}/${MAX_ACCOUNT_SWITCHES})`,
            { repo: input.repo, issue: input.issueNumber },
          );
          fs.appendFileSync(
            transcriptPath,
            `${JSON.stringify({ event: "continuity_failover", from: account.id, switches, reason: "rate_limit_or_quota", ts: Date.now() })}\n`,
          );
        }
      }

      throw new AttemptError("quota", `All fallback subscription providers exhausted: ${errors.join(" | ")}`);
    } finally {
      fs.rmSync(attemptTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}

/** Attempt transcripts and provider logs are kept this long; the Ledger keeps the paths, readers only print them. */
export const TRANSCRIPT_RETENTION_MS = 30 * 86_400_000;
const TRANSCRIPT_FILE_RE = /^issue-.+\.(jsonl|stdout|stderr)$/;

/** Delete old transcript files directly inside `dir` (no recursion, no symlinks, nothing else). Returns the count removed. */
export function pruneTranscripts(dir: string, beforeMs: number): number {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  for (const e of entries) {
    if (!e.isFile() || !TRANSCRIPT_FILE_RE.test(e.name)) continue;
    const file = path.join(dir, e.name);
    if (fs.lstatSync(file).mtimeMs >= beforeMs) continue;
    fs.rmSync(file);
    removed++;
  }
  return removed;
}
