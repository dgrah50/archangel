import type { HostStatus } from "../../src/core/host-facts.js";
import type { LogsPayload, ThreadDetail } from "../../src/core/ui-thread.js";
import type { EvalsState } from "../../src/core/eval-reports.js";
import type { SettingsState } from "../../src/core/ui-settings.js";
import type { UiState, WorkflowsState } from "../../src/core/ui-state.js";

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Display order of the Threads page; src/core/ui-state.ts NEED_GROUPS is the same list (pinned by a test). */
export const NEED_GROUPS_UI = ["Needs you", "Ready for owner", "Stuck", "In review", "Waiting on CI", "Working", "Queued", "Done in last 7 days"] as const;
const STAGE_NAMES = ["Working", "Waiting on CI", "In review", "Ready for owner", "Needs you", "Owner driving", "Queued", "Done in last 7 days"];

/** Structural guard for /api/state: a corrupt or partial payload must surface as an error, never render as blank or zero. */
export function isUiState(v: unknown): v is UiState {
  if (!obj(v)) return false;
  return (
    typeof v.generatedAt === "number" &&
    Array.isArray(v.needsYou) &&
    obj(v.stages) &&
    STAGE_NAMES.every((s) => Array.isArray((v.stages as Record<string, unknown>)[s])) &&
    obj(v.groups) &&
    NEED_GROUPS_UI.every((g) => Array.isArray((v.groups as Record<string, unknown>)[g])) &&
    obj(v.outcomes) &&
    obj(v.autonomySteps) &&
    Array.isArray(v.daily) &&
    Array.isArray(v.scouts) &&
    (v.daemonHeartbeatAt === null || typeof v.daemonHeartbeatAt === "number")
  );
}

export function isWorkflowsState(v: unknown): v is WorkflowsState {
  return obj(v) && typeof v.generatedAt === "number" && typeof v.windowDays === "number" && Array.isArray(v.repos) && v.repos.every((r) => obj(r) && typeof r.repo === "string" && Array.isArray(r.stages));
}

export function isThreadDetail(v: unknown): v is ThreadDetail {
  return obj(v) && typeof v.repo === "string" && typeof v.issueNumber === "number" && typeof v.title === "string" && Array.isArray(v.events) && v.events.every((e) => obj(e) && typeof e.ts === "number" && typeof e.title === "string" && Array.isArray(e.details));
}

export function isHostStatus(v: unknown): v is HostStatus {
  return obj(v) && typeof v.reported === "boolean" && typeof v.restartPending === "boolean" && typeof v.disk === "string";
}

export function isSettingsState(v: unknown): v is SettingsState {
  return obj(v) && obj(v.host) && typeof v.host.state === "string" && obj(v.status) && Array.isArray(v.env) && obj(v.kernel) && Array.isArray(v.kernel.universalProtected);
}

export function isEvalsState(v: unknown): v is EvalsState {
  return obj(v) && typeof v.generatedAt === "number" && Array.isArray(v.runs) && v.runs.every((r) => obj(r) && typeof r.file === "string" && typeof r.savedAt === "number" && typeof r.unreadable === "boolean");
}

export function isLogs(v: unknown): v is LogsPayload {
  return obj(v) && typeof v.missing === "boolean" && Array.isArray(v.entries);
}

/** One feed polled independently of the others, validated before it is trusted. */
export async function fetchFeed<T>(url: string, valid: (v: unknown) => v is T): Promise<T> {
  const res = await fetch(url);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url}: HTTP ${res.status}, reply is not JSON`);
  }
  if (!res.ok) throw new Error(`${url}: ${(body as { error?: string } | null)?.error ?? `HTTP ${res.status}`}`);
  if (!valid(body)) throw new Error(`${url}: unexpected data shape (partial or corrupt reply)`);
  return body;
}
