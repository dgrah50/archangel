import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { providerToVendor, type CliProvider, type ProviderEntry } from "../config.js";
import type { ReviewerVendor } from "../ledger/schema.js";
import { promptTemplateSha } from "./prompts.js";
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

export type ReviewerCliInvoker = (input: {
  provider: CliProvider;
  model?: string;
  prompt: string;
  timeoutMs: number;
}) => Promise<unknown>;

function parseJsonEnvelope(stdout: string): unknown {
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
        try {
          return JSON.parse(obj.response);
        } catch {
          // fall through
        }
      }
      if (typeof obj.result === "string") {
        try {
          return JSON.parse(obj.result);
        } catch {
          // fall through
        }
      }
      return obj;
    } catch (err) {
      if (err instanceof Error && !err.message.includes("JSON")) {
        throw err;
      }
      // keep scanning non-JSON lines
    }
  }
  return undefined;
}

function defaultReviewerCliInvoker(input: {
  provider: CliProvider;
  model?: string;
  prompt: string;
  timeoutMs: number;
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
    bin = "agy";
    args = [
      "--mode",
      "plan",
      "--disable-slash-commands",
      "--output-format",
      "json",
      "--json-schema",
      schemaStr,
      ...(input.model ? ["--model", input.model] : []),
      `-p=${input.prompt}`,
    ];
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

  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: tmpDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

    child.on("error", (err) => {
      clearTimeout(timer);
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) {
          reject(new Error(`${input.provider} exited ${code}: ${(stderr || stdout).trim().slice(-600)}`));
          return;
        }
        if (input.provider === "codex" && fs.existsSync(outFile)) {
          const raw = fs.readFileSync(outFile, "utf8").trim();
          resolve(raw ? JSON.parse(raw) : undefined);
          return;
        }
        resolve(parseJsonEnvelope(stdout));
      } catch (err) {
        reject(err);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

    if (stdinPrompt !== null) {
      child.stdin.write(stdinPrompt);
    }
    child.stdin.end();
  });
}

export interface SubscriptionReviewerOptions {
  chain: ProviderEntry[];
  primaryImplementerVendor: ReviewerVendor;
  timeoutMs?: number;
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
  private readonly primaryImplementerVendor: ReviewerVendor;
  private readonly timeoutMs: number;
  private readonly invoker: ReviewerCliInvoker;
  private readonly prompts: ReviewPromptBuilders;

  constructor(opts: SubscriptionReviewerOptions) {
    this.prompts = opts.prompts ?? DEFAULT_REVIEW_PROMPTS;
    this.chain = opts.chain;
    this.primaryImplementerVendor = opts.primaryImplementerVendor;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.invoker = opts.invoker ?? defaultReviewerCliInvoker;
  }

  async reviewAll(req: ReviewRequest): Promise<ReviewBatchOutcome> {
    const skip = new Set<ReviewerVendor>(req.skipVendors ?? []);
    const excluded = new Set<ReviewerVendor>(
      req.excludeVendors && req.excludeVendors.length > 0
        ? req.excludeVendors
        : [this.primaryImplementerVendor],
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
      const raw = await this.invoker({
        provider: item.entry.provider,
        model: item.entry.model,
        prompt,
        timeoutMs: this.timeoutMs,
      });
      const parsed = parseStrictVerdict(raw);
      return {
        vendor: item.vendor,
        verdict: parsed.verdict,
        findings: parsed.findings,
        costUsd: 0,
        provider: item.entry.provider,
        model: item.entry.model ?? null,
        promptSha256: promptTemplateSha(slotIndex === 0 ? "review_contract" : "review_adversarial"),
      };
    };

    const settled = await Promise.allSettled(active.map((item, idx) => runEntry(item, idx)));
    const results: VendorReviewResult[] = [];
    const errors: Array<{ vendor: ReviewerVendor; error: string }> = [];

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
            errors.push({
              vendor: backup.vendor,
              error: backupErr instanceof Error ? backupErr.message : String(backupErr),
            });
          }
        }
        errors.push({ vendor: item.vendor, error: msg });
      }
    }

    return { results, errors };
  }
}
