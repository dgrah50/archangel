import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

import type { WorkspaceHandle } from "../compute/lazy-workspace.js";
import type { WriterRole } from "../config.js";
import type { ReviewerVendor } from "../ledger/schema.js";

export interface ImplementInput {
  issueNumber: number;
  /** Where the agent may run. Each chain entry runs in exactly one of them: claude in `remote` when there is one, everything else in `local`. */
  workspaces: { local: WorkspaceHandle; remote?: WorkspaceHandle };
  prompt: string;
  abortController: AbortController;
  maxTurns: number;
  timeoutMs: number;
  maxBudgetUsd: number;
  preferVendors?: ReviewerVendor[];
  /** Which provider chain runs this Attempt (implement, revise or LLM rebase). */
  role: WriterRole;
}

export interface ImplementResult {
  summary: string;
  costUsd: number;
  transcriptPath: string | null;
  aborted: boolean;
  providersUsed?: ReviewerVendor[];
  /** Set when the run ended without finishing the job (e.g. the SDK's `error_max_turns`); the Attempt then fails with this cause. */
  failure?: string;
  /** Wall time of the agent runs in this Attempt, and the highest peak RSS (KB) of their process trees; absent when not measured. */
  durationMs?: number;
  peakRssKb?: number;
  /** The provider and model that produced this result (replay provenance); absent when none finished. */
  /** Which workspace the last agent run used; the caller collects from it. Absent means `local`. */
  ranOn?: "local" | "remote";
  runBy?: { provider: string; model: string | null; accountId?: string };
}

export interface Implementer {
  run(input: ImplementInput): Promise<ImplementResult>;
}

export interface ClaudeImplementerOptions {
  apiKey: string;
  model: string;
  transcriptsDir: string;
  denyReadPaths?: string[];
}

/**
 * Direct `@anthropic-ai/claude-agent-sdk` implementer (ADR-0001 + ADR-0004 + H1 hardening):
 * - Uses a per-attempt throwaway HOME + per-attempt GOCACHE inside TMPDIR.
 * - Scrubs ambient GitHub/SSH/AWS credentials from env.
 * - Disables repo/user settingSources so untrusted repo hooks/CLAUDE.md cannot execute.
 * - Enables strict Seatbelt sandbox (`allowUnsandboxedCommands: false`, `failIfUnavailable: true`,
 *   `filesystem.denyRead` covering ~/.config/gh, ~/.ssh, ~/.aws, .env, PEM, and .archangel).
 * - Disallows `WebFetch` and `WebSearch`.
 */
export class ClaudeSdkImplementer implements Implementer {
  private readonly opts: ClaudeImplementerOptions;

  constructor(opts: ClaudeImplementerOptions) {
    this.opts = opts;
  }

  async run(input: ImplementInput): Promise<ImplementResult> {
    fs.mkdirSync(this.opts.transcriptsDir, { recursive: true });
    const transcriptPath = path.join(
      this.opts.transcriptsDir,
      `issue-${input.issueNumber}-${Date.now()}.jsonl`,
    );

    const attemptTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `archangel-impl-${input.issueNumber}-`));
    const fakeHome = path.join(attemptTempRoot, "home");
    const goCacheDir = path.join(attemptTempRoot, "gocache");
    fs.mkdirSync(fakeHome, { recursive: true });
    fs.mkdirSync(goCacheDir, { recursive: true });

    const realHome = os.homedir();
    const defaultGoModCache = process.env.GOMODCACHE ?? path.join(realHome, "go", "pkg", "mod");
    const denyRead = [
      ...new Set(
        [
          path.join(realHome, ".config", "gh"),
          path.join(realHome, ".config", "archangel"),
          path.join(realHome, ".ssh"),
          path.join(realHome, ".aws"),
          path.join(realHome, ".netrc"),
          path.resolve(".env"),
          path.resolve(".env.local"),
          path.resolve(".archangel"),
          ...(this.opts.denyReadPaths ?? []).map((p) => path.resolve(p)),
        ].filter(Boolean),
      ),
    ];

    const scrubbedEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: fakeHome,
      TMPDIR: attemptTempRoot,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      ANTHROPIC_API_KEY: this.opts.apiKey,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GOCACHE: goCacheDir,
      ...(fs.existsSync(defaultGoModCache) ? { GOMODCACHE: defaultGoModCache } : {}),
    };

    const timer = setTimeout(() => {
      input.abortController.abort(new Error(`Implement attempt timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);

    const logStream = fs.createWriteStream(transcriptPath, { flags: "a" });
    let summary = "";
    let costUsd = 0;
    let failure: string | undefined;

    try {
      const stream = query({
        prompt: input.prompt,
        options: {
          cwd: (await input.workspaces.local.workspace()).path,
          model: this.opts.model,
          env: scrubbedEnv,
          abortController: input.abortController,
          maxTurns: input.maxTurns,
          maxBudgetUsd: input.maxBudgetUsd,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          disallowedTools: ["WebFetch", "WebSearch"],
          settingSources: [],
          persistSession: false,
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: true,
            allowUnsandboxedCommands: false,
            filesystem: {
              denyRead,
            },
          },
        },
      });

      for await (const msg of stream) {
        logStream.write(`${JSON.stringify(msg)}\n`);
        if (msg.type === "result") {
          costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : costUsd;
          if (msg.subtype === "success") {
            summary = msg.result ?? "";
          } else {
            failure = msg.subtype; // error_max_turns, error_max_budget_usd, error_during_execution, ...
          }
        }
      }

      return {
        summary: summary || "Completed implement attempt.",
        costUsd,
        transcriptPath,
        aborted: input.abortController.signal.aborted,
        runBy: { provider: "claude", model: this.opts.model },
        ...(failure ? { failure } : {}),
      };
    } catch (err) {
      if (input.abortController.signal.aborted) {
        return {
          summary: "Aborted",
          costUsd,
          transcriptPath,
          aborted: true,
        };
      }
      throw err;
    } finally {
      clearTimeout(timer);
      logStream.end();
      fs.rmSync(attemptTempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}
