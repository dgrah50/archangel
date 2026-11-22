import type { SignalTaint } from "../ledger/schema.js";

/**
 * O8 signal kinds. Taint belongs to the kind, never to a payload or a rule, so no config or prompt can relabel a signal.
 */
export const SIGNAL_KINDS = {
  pr_merged: { source: "github", taint: "mechanical" },
  release: { source: "github", taint: "mechanical" },
  advisory: { source: "github_advisory", taint: "untrusted" },
  /** Public-internet research the host fetched: the payload is only a day and a count, never fetched text. */
  research: { source: "research", taint: "untrusted" },
  schedule: { source: "schedule", taint: "owner" },
  /** Computed here from local telemetry by arithmetic only, never from outside text. */
  telemetry_anomaly: { source: "telemetry", taint: "mechanical" },
  /** Computed here from the Ledger by arithmetic only: a (workflow, prompt) policy version whose outcomes got worse. */
  policy_regression: { source: "regression_watch", taint: "mechanical" },
} as const satisfies Record<string, { source: string; taint: SignalTaint }>;
export type SignalKind = keyof typeof SIGNAL_KINDS;
