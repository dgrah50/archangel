import fs from "node:fs";
import path from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  event: string;
  repo?: string;
  issue?: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface Logger {
  info(event: string, message: string, meta?: { repo?: string; issue?: number; data?: Record<string, unknown> }): void;
  warn(event: string, message: string, meta?: { repo?: string; issue?: number; data?: Record<string, unknown> }): void;
  error(event: string, message: string, meta?: { repo?: string; issue?: number; data?: Record<string, unknown> }): void;
}

export const NOOP_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
};

/**
 * Dual-sink structured logger:
 * - Concise timestamped lines on stdout for human supervision during `archangel start`.
 * - Append-only JSONL stream (`.archangel/archangel.log.jsonl`) for automated post-mortems & metrics.
 */
export class ArchangelLogger implements Logger {
  private readonly logFilePath?: string;
  private lastSinkWarnAt = 0;
  private readonly consoleOutput: boolean;

  constructor(opts: { logFilePath?: string; consoleOutput?: boolean } = {}) {
    this.logFilePath = opts.logFilePath;
    this.consoleOutput = opts.consoleOutput ?? true;
    if (this.logFilePath) {
      fs.mkdirSync(path.dirname(path.resolve(this.logFilePath)), { recursive: true });
    }
  }

  info(event: string, message: string, meta?: { repo?: string; issue?: number; data?: Record<string, unknown> }): void {
    this.emit("info", event, message, meta);
  }

  warn(event: string, message: string, meta?: { repo?: string; issue?: number; data?: Record<string, unknown> }): void {
    this.emit("warn", event, message, meta);
  }

  error(event: string, message: string, meta?: { repo?: string; issue?: number; data?: Record<string, unknown> }): void {
    this.emit("error", event, message, meta);
  }

  private emit(
    level: LogLevel,
    event: string,
    message: string,
    meta?: { repo?: string; issue?: number; data?: Record<string, unknown> },
  ): void {
    const now = new Date();
    const record: LogRecord = {
      ts: now.toISOString(),
      level,
      event,
      ...(meta?.repo ? { repo: meta.repo } : {}),
      ...(meta?.issue !== undefined ? { issue: meta.issue } : {}),
      message,
      ...(meta?.data ? { data: meta.data } : {}),
    };

    if (this.consoleOutput) {
      const hhmmss = now.toTimeString().slice(0, 8);
      const scope =
        meta?.repo && meta?.issue !== undefined
          ? `[${meta.repo}#${meta.issue}]`
          : meta?.repo
            ? `[${meta.repo}]`
            : "[archangel]";
      const prefix = level === "info" ? "" : `${level.toUpperCase()} `;
      const line = `[${hhmmss}] ${scope} ${prefix}${message}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }

    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, `${JSON.stringify(record)}\n`, "utf8");
      } catch (err) {
        // Never crash the reconciler on a log disk write error, but do not drop the JSONL sink silently: warn on stderr at most once a minute.
        const at = Date.now();
        if (at - this.lastSinkWarnAt >= 60_000) {
          this.lastSinkWarnAt = at;
          console.error(`[archangel] log file write failed (${this.logFilePath}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}
