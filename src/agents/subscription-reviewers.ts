import { agyCommand } from "../compute/agy-broker-adapter.js";
import { execInGroup } from "../compute/local.js";
import fs from "node:fs";
import os from "node:os";
import { tryParseJson } from "../core/json.js";
import path from "node:path";
import { DEFAULT_ACCOUNTS, accountEnv, accountsFor, providerToVendor, type Account, type CliProvider, type ProviderEntry } from "../config.js";
import { ACCOUNT_COOLDOWN_MS, MAX_ACCOUNT_SWITCHES, NO_ACCOUNT_STATE, selectAccount, type AccountLedger, cooldownAfterLimit } from "../core/accounts.js";
import type { ReviewerVendor } from "../ledger/schema.js";
import { promptTemplateSha } from "./prompts.js";
import { timeReview } from "../core/telemetry.js";
import {
  DEFAULT_REVIEW_PROMPTS,
  parseStrictVerdict,
  type ReviewPromptBuilders,
  type ReviewBatchOutcome,
  type ReviewRequest,
  type ReviewerSuite,
  type VendorReviewResult,
} from "./reviewers.js";
import { isRateLimitOrQuotaError } from "./subscription-implementer.js";

const REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "veto"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          summary: { type: "string" },
          suggestion: { type: ["string", "null"] },
        },
        required: ["file", "line", "severity", "summary", "suggestion"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "findings"],
  additionalProperties: false,
};

/** How long a CLI gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000;

export type ReviewerCliInvoker = (input: {
  provider: CliProvider;
  model?: string;
  account?: Account;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<unknown>;

export function parseJsonEnvelope(stdout: string): unknown {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line) as {
        status?: string;
        is_error?: boolean;
        error?: string;
        denied_actions?: Array<{ action?: string; display_name?: string }>;
        structured_output?: unknown;
        response?: string;
        result?: string;
      };
      if (obj.is_error === true || (typeof obj.status === "string" && obj.status.toUpperCase() === "ERROR")) {
        throw new Error(obj.error ?? obj.result ?? obj.response ?? "CLI returned error envelope");
      }
      if (
        Array.isArray(obj.denied_actions) &&
        obj.denied_actions.length > 0 &&
        !obj.structured_output &&
        !obj.response
      ) {
        throw new Error(
          `CLI attempted denied tool action(s): ${obj.denied_actions.map((d) => d.display_name ?? d.action).join(", ")}`,
        );
      }
      if (obj.structured_output && typeof obj.structured_output === "object") {
        return obj.structured_output;
      }
      if (typeof obj.response === "string") {
        const inner = tryParseJson(obj.response);
        if (inner.ok) return inner.value;
      }
      if (typeof obj.result === "string") {
        const inner = tryParseJson(obj.result);
        if (inner.ok) return inner.value;
      }
      return obj;
    } catch (err) {
      // Only a line that is not JSON is skipped; a real error envelope is an error whatever words its text contains.
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return undefined;
}

export async function defaultReviewerCliInvoker(input: {
  provider: CliProvider;
  model?: string;
  account?: Account;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<unknown> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `archangel-sub-rev-${input.provider}-`));
  const schemaFile = path.join(tmpDir, "schema.json");
  const outFile = path.join(tmpDir, "out.json");
  const schemaStr = JSON.stringify(REVIEW_JSON_SCHEMA);
  fs.writeFileSync(schemaFile, schemaStr, "utf8");

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
    HOME: os.homedir(),
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: tmpDir,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
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
      "read-only",
      "--ignore-user-config",
      "--ignore-rules",
      "--ephemeral",
      "--skip-git-repo-check",
      "--output-schema",
      schemaFile,
      "-o",
      outFile,
      ...(input.model ? ["-m", input.model] : []),
      "-",
    ];
    stdinPrompt = input.prompt;
  } else if (input.provider === "agy") {
    ({ cmd: bin, args } = agyCommand(input.account, [
      "--mode",
      "plan",
      "--disable-slash-commands",
      "--output-format",
      "json",
      "--json-schema",
      schemaStr,
      ...(input.model ? ["--model", input.model] : []),
      `-p=${input.prompt}`,
    ]));
  } else {
    bin = "claude";
    args = [
      "-p",
      "--permission-mode",
      "plan",
      "--output-format",
      "json",
      "--json-schema",
      schemaStr,
      "--no-session-persistence",
      "--setting-sources",
      "",
      ...(input.model ? ["--model", input.model] : []),
    ];
    stdinPrompt = input.prompt;
  }

  try {
    let timedOut = false;
    const res = await execInGroup(tmpDir, { cmd: bin, args, env, stdin: stdinPrompt ?? undefined, timeoutMs: input.timeoutMs, onTimeout: () => (timedOut = true), killGraceMs: KILL_GRACE_MS, signal: input.signal });
    if (input.signal?.aborted) throw new Error(`${input.provider} review stopped: the daemon is shutting down`);
    // Said plainly: a CLI killed at the limit otherwise reports only its own "interrupted".
    if (timedOut) throw new Error(`${input.provider} review timed out after ${Math.round(input.timeoutMs / 1000)} s (reviewTimeoutMs)`);
    if (res.code !== 0) throw new Error(`${input.provider} exited ${res.code}: ${(res.stderr || res.stdout).trim().slice(-600)}`);
    if (input.provider === "codex" && fs.existsSync(outFile)) {
      const raw = fs.readFileSync(outFile, "utf8").trim();
      return raw ? JSON.parse(raw) : undefined;
    }
    return parseJsonEnvelope(res.stdout);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Every login of a reviewer's provider is cooling down after a usage limit (or at its daily cap). */
class ReviewerAtLimit extends Error {
  constructor(
    provider: CliProvider,
    /** When the first of them is usable again; null when none is cooling (all at their daily cap). */
    readonly retryAt: number | null,
  ) {
    super(`no available ${provider} account: usage limit reached on every account${retryAt === null ? "" : `, the first usable again at ${new Date(retryAt).toISOString()}`}`);
  }
}

export interface SubscriptionReviewerOptions {
  chain: ProviderEntry[];
  accounts?: Account[];
  /** Per-account cooldowns and usage; without it selection is config order and nothing cools down. */
  accountState?: AccountLedger;
  /** Vendors excluded when a request names none: the first provider of each writing role's chain. */
  defaultExcludeVendors: ReviewerVendor[];
  /** `reviewTimeoutMs` from the host config. */
  timeoutMs: number;
  invoker?: ReviewerCliInvoker;
  /** Prompt templates; defaults to the current ones (eval passes a candidate's). */
  prompts?: ReviewPromptBuilders;
}

/**
 * Subscription-backed independent CLI ReviewerSuite (ADR-0003 + Continuity fallback):
 * - Runs 2 distinct independent reviewers in parallel (`agy`, `claude`, `codex`) strictly excluding
 *   the implementer's vendor(s).
 * - Uses `Promise.allSettled` so surviving vendor approvals persist immediately.
 * - If a reviewer hits a rate/quota limit and a 3rd independent vendor is available in `chain`,
 *   automatically fails over to it without violating cross-vendor independence.
 */
export class SubscriptionReviewerSuite implements ReviewerSuite {
  private readonly chain: ProviderEntry[];
  private readonly accounts: Account[];
  private readonly state: AccountLedger;
  private readonly defaultExcludeVendors: ReviewerVendor[];
  private readonly timeoutMs: number;
  private readonly invoker: ReviewerCliInvoker;
  private readonly prompts: ReviewPromptBuilders;

  constructor(opts: SubscriptionReviewerOptions) {
    this.prompts = opts.prompts ?? DEFAULT_REVIEW_PROMPTS;
    this.chain = opts.chain;
    this.accounts = opts.accounts ?? DEFAULT_ACCOUNTS;
    this.state = opts.accountState ?? NO_ACCOUNT_STATE;
    this.defaultExcludeVendors = opts.defaultExcludeVendors;
    this.timeoutMs = opts.timeoutMs;
    this.invoker = opts.invoker ?? defaultReviewerCliInvoker;
  }

  async reviewAll(req: ReviewRequest): Promise<ReviewBatchOutcome> {
    const skip = new Set<ReviewerVendor>(req.skipVendors ?? []);
    const excluded = new Set<ReviewerVendor>(
      req.excludeVendors && req.excludeVendors.length > 0
        ? req.excludeVendors
        : this.defaultExcludeVendors,
    );

    // Eligible independent providers in configured preference order (deduped by vendor).
    const eligible: Array<{ entry: ProviderEntry; vendor: ReviewerVendor }> = [];
    const seenVendors = new Set<ReviewerVendor>();
    for (const entry of this.chain) {
      const vendor = providerToVendor(entry.provider);
      if (excluded.has(vendor) || skip.has(vendor) || seenVendors.has(vendor)) continue;
      seenVendors.add(vendor);
      eligible.push({ entry, vendor });
    }

    const needed = Math.max(0, 2 - skip.size);
    const active = eligible.slice(0, needed);
    const backups = eligible.slice(needed);

    const runEntry = async (
      item: { entry: ProviderEntry; vendor: ReviewerVendor },
      slotIndex: number,
    ): Promise<VendorReviewResult> => {
      const prompt = slotIndex === 0 ? this.prompts.contract(req) : this.prompts.adversarial(req);
      // The account is picked per run; a limit error cools it down and the next account of the SAME vendor runs (reviewer
      // independence is by vendor, so two accounts of one vendor are still one reviewer).
      const tried = new Set<string>();
      let switches = 0;
      for (;;) {
        const account = selectAccount(accountsFor(this.accounts, item.entry), this.state, Date.now(), { exclude: tried });
        if (!account) {
          const ends = accountsFor(this.accounts, item.entry).flatMap((a) => this.state.cooldownUntil(a.id, Date.now()) ?? []);
          throw new ReviewerAtLimit(item.entry.provider, ends.length > 0 ? Math.min(...ends) : null);
        }
        tried.add(account.id);
        let raw: unknown;
        try {
          raw = await this.invoker({
            provider: item.entry.provider,
            model: item.entry.model,
            account,
            prompt,
            timeoutMs: this.timeoutMs,
            signal: req.signal,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isRateLimitOrQuotaError(msg)) {
            this.state.recordCooldown(account.id, cooldownAfterLimit(msg), msg.slice(0, 200));
            if (++switches <= MAX_ACCOUNT_SWITCHES) continue;
          }
          throw err;
        }
        const parsed = parseStrictVerdict(raw);
        return {
          vendor: item.vendor,
          verdict: parsed.verdict,
          findings: parsed.findings,
          costUsd: 0,
          provider: item.entry.provider,
          model: item.entry.model ?? null,
          accountId: account.id,
          promptSha256: promptTemplateSha(slotIndex === 0 ? "review_contract" : "review_adversarial"),
        };
      }
    };

    const settled = await Promise.allSettled(active.map((item, idx) => timeReview(item.vendor, runEntry(item, idx))));
    const results: VendorReviewResult[] = [];
    const errors: ReviewBatchOutcome["errors"] = [];
    const failure = (vendor: ReviewerVendor, err: unknown) => ({
      vendor,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof ReviewerAtLimit && err.retryAt !== null ? { retryAt: err.retryAt } : {}),
    });

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      const item = active[i]!;
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        // Continuity fallback for reviewer slot if a backup independent vendor exists!
        if (isRateLimitOrQuotaError(msg) && backups.length > 0) {
          const backup = backups.shift()!;
          try {
            const fallbackRes = await runEntry(backup, i);
            results.push(fallbackRes);
            continue;
          } catch (backupErr) {
            errors.push(failure(backup.vendor, backupErr));
          }
        }
        errors.push(failure(item.vendor, outcome.reason));
      }
    }

    return { results, errors };
  }
}
