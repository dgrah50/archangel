import type { UiState, WorkflowsState } from "../../src/core/ui-state.js";

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const STAGE_NAMES = ["Working", "Waiting on CI", "In review", "Ready for owner", "Needs you", "Owner driving", "Queued", "Done in last 7 days"];

/** Structural guard for /api/state: a corrupt or partial payload must surface as an error, never render as blank or zero. */
export function isUiState(v: unknown): v is UiState {
  if (!obj(v)) return false;
  return (
    typeof v.generatedAt === "number" &&
    Array.isArray(v.needsYou) &&
    obj(v.stages) &&
    STAGE_NAMES.every((s) => Array.isArray((v.stages as Record<string, unknown>)[s])) &&
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
