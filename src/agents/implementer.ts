import type { WorkspaceHandle } from "../compute/lazy-workspace.js";
import type { WriterRole } from "../config.js";
import type { ReviewerVendor } from "../ledger/schema.js";

export interface ImplementInput {
  /** `owner/name`, for log lines. */
  repo?: string;
  issueNumber: number;
  /** Where the agent may run. Each chain entry runs in exactly one of them: claude in `remote` when there is one, everything else in `local`. */
  workspaces: { local: WorkspaceHandle; remote?: WorkspaceHandle };
  prompt: string;
  abortController: AbortController;
  timeoutMs: number;
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
  /** Set when the run ended without finishing the job; the Attempt then fails with this cause. */
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
  /**
   * When no login of the role's chain can run right now (each is cooling down after a usage limit, or at its daily cap): the
   * time one is next usable. Null when a run can start now. Absent for implementers with no accounts to wait on.
   */
  blockedUntil?(role: WriterRole, now: number): number | null;
}

