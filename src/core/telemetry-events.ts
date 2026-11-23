/**
 * The closed telemetry vocabulary: every event Archangel records about itself, with its one-line purpose and the only
 * tags it may carry. A tag is a fixed enum or a short id (an account slug). Nothing else can be stored: no free text, URLs,
 * file contents, prompts, model output, secrets or owner details. Telemetry stays in the local Ledger and is never sent anywhere.
 */

const ID = "id" as const;
type TagSpec = readonly string[] | typeof ID;

const GITHUB_ENDPOINTS = ["issues", "pulls", "checks", "git", "contents", "signals", "auth", "other"] as const;
const STATUS_CLASSES = ["2xx", "4xx", "5xx", "429", "error"] as const;
const PROVIDERS = ["claude", "codex", "agy"] as const;
const ATTEMPT_KINDS = ["plan", "implement", "revise", "rebase"] as const;
const ATTEMPT_OUTCOMES = ["succeeded", "failed", "aborted"] as const;
const VENDORS = ["openai", "gemini", "anthropic"] as const;

export const TELEMETRY_EVENTS = {
  tick_ms: { purpose: "Wall time of one reconciler tick for one repo; growth means the factory is slowing down.", tags: {} },
  tick_phase_ms: { purpose: "Wall time of one phase inside a tick; says where a slow tick spends its time.", tags: { phase: ["sync", "threads", "signals", "scouts"] } },
  github_call_ms: { purpose: "Latency of one GitHub API call by endpoint class and status class; feeds error-rate and 429 checks.", tags: { endpoint: GITHUB_ENDPOINTS, status: STATUS_CLASSES } },
  account_cooldown: { purpose: "An account hit a rate or quota limit and went into cooldown (value 1); repeats mean the account is undersized.", tags: { account: ID } },
  attempt_ms: { purpose: "Wall time of one finished Attempt by kind, provider and outcome.", tags: { kind: ATTEMPT_KINDS, provider: [...PROVIDERS, "none"], outcome: ATTEMPT_OUTCOMES } },
  attempt_rss_kb: { purpose: "Peak memory of one finished Attempt's agent run, in KB.", tags: { kind: ATTEMPT_KINDS, provider: [...PROVIDERS, "none"] } },
  gate_ms: { purpose: "Duration of one local Gate validation by outcome; repeated timeouts mean the Gate bounds or the host are wrong.", tags: { outcome: ["passed", "failed", "timeout", "error"] } },
  broker_ms: { purpose: "Duration of one Broker clone or fetch.", tags: { op: ["clone", "fetch"] } },
  review_ms: { purpose: "Latency of one reviewer run by vendor and verdict.", tags: { vendor: VENDORS, verdict: ["approve", "veto", "error"] } },
  scout_run: { purpose: "One Scout run finished (value 1) by outcome.", tags: { outcome: ["ran", "partial_error", "failed_output", "skipped", "paused", "dry_run"] } },
  signal_ingested: { purpose: "Signals newly recorded by the adapters in one pass, by kind (value is the count).", tags: { kind: ["pr_merged", "release", "advisory", "research", "schedule", "telemetry_anomaly", "policy_regression", "prod_errors", "prod_error_spike"] } },
  signal_action: { purpose: "A signal rule acted (value 1) by action and outcome.", tags: { action: ["file_issue", "run_scout", "run_pitch"], outcome: ["done", "failed", "rejected"] } },
  daemon_start: { purpose: "The daemon started (value 1); a burst of these is a restart loop.", tags: {} },
} as const satisfies Record<string, { purpose: string; tags: Record<string, TagSpec> }>;

export type TelemetryName = keyof typeof TELEMETRY_EVENTS;
type TagValue<S> = S extends readonly (infer E)[] ? E : string;
export type TelemetryTags<N extends TelemetryName> = { [K in keyof (typeof TELEMETRY_EVENTS)[N]["tags"]]: TagValue<(typeof TELEMETRY_EVENTS)[N]["tags"][K]> };

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/** Validates tags against the event's closed shape (every key present, no extras, enum members or short ids only). Throws otherwise. */
export function checkTags(name: string, tags: Record<string, unknown>): Record<string, string> {
  const event = (TELEMETRY_EVENTS as Record<string, { tags: Record<string, TagSpec> }>)[name];
  if (!event) throw new Error(`unknown telemetry event '${name}'`);
  const keys = Object.keys(event.tags);
  if (Object.keys(tags).some((k) => !keys.includes(k))) throw new Error(`telemetry '${name}': unexpected tag`);
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = tags[k];
    const spec = event.tags[k]!;
    const ok = typeof v === "string" && (spec === ID ? ID_RE.test(v) : spec.includes(v));
    if (!ok) throw new Error(`telemetry '${name}': bad value for tag '${k}'`);
    out[k] = v as string;
  }
  return out;
}
