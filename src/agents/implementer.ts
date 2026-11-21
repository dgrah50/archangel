import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface ImplementInput {
  issueNumber: number;
  cloneDir: string;
  prompt: string;
  abortController: AbortController;
  maxTurns: number;
  timeoutMs: number;
  maxBudgetUsd: number;
}

export interface ImplementResult {
  summary: string;
  costUsd: number;
  transcriptPath: string | null;
  aborted: boolean;
}

export interface Implementer {
  run(input: ImplementInput): Promise<ImplementResult>;
}

export interface ClaudeImplementerOptions {
  apiKey: string;
  model: string;
  transcriptsDir: string;
}

/**
 * Direct `@anthropic-ai/claude-agent-sdk` implementer (ADR-0001 + ADR-0004):
 * - Scrubs ambient GitHub/SSH/AWS credentials from env.
 * - Disables repo/user settingSources so untrusted repo hooks/CLAUDE.md cannot execute.
 * - Enables Claude Code's built-in Seatbelt sandbox on macOS.
 * - Enforces AbortController + wall-clock timeout + maxTurns + maxBudgetUsd.
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

    const goCacheDir = path.join(os.tmpdir(), "archangel-go-build-cache");
    fs.mkdirSync(goCacheDir, { recursive: true });

    const scrubbedEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      ANTHROPIC_API_KEY: this.opts.apiKey,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      // Redirect GOCACHE into writable TMPDIR if a target repo happens to be Go under macOS Seatbelt.
      GOCACHE: goCacheDir,
      ...(process.env.GOMODCACHE ? { GOMODCACHE: process.env.GOMODCACHE } : {}),
    };

    const timer = setTimeout(() => {
      input.abortController.abort(new Error(`Implement attempt timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);

    const logStream = fs.createWriteStream(transcriptPath, { flags: "a" });
    let summary = "";
    let costUsd = 0;

    try {
      const stream = query({
        prompt: input.prompt,
        options: {
          cwd: input.cloneDir,
          model: this.opts.model,
          env: scrubbedEnv,
          abortController: input.abortController,
          maxTurns: input.maxTurns,
          maxBudgetUsd: input.maxBudgetUsd,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          settingSources: [],
          persistSession: false,
          sandbox: {
            enabled: true,
            autoAllowBashIfSandboxed: true,
          },
        },
      });

      for await (const msg of stream) {
        logStream.write(`${JSON.stringify(msg)}\n`);
        if (msg.type === "result") {
          costUsd = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : costUsd;
          if (msg.subtype === "success") {
            summary = msg.result ?? "";
          }
        }
      }

      return {
        summary: summary || "Completed implement attempt.",
        costUsd,
        transcriptPath,
        aborted: input.abortController.signal.aborted,
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
    }
  }
}
