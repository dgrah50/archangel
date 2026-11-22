import type { ApplyResult, HostConfigRead, PreviewResult } from "../../src/core/ui-host-config.js";
import { SCHEMA_BEHIND } from "./payload";
import { csrfToken } from "./workflow-draft";

const URL = "/api/host-config";
export type HostErrorKind = "conflict" | "validation" | "forbidden" | "unauthorized" | "schema_behind" | "network" | "error";
export interface HostError {
  kind: HostErrorKind;
  message: string;
}
export type HostResult<T> = { ok: true; value: T } | { ok: false; error: HostError };

function classify(status: number, body: { error?: string } | null, text: string): HostError {
  const message = body?.error ?? `HTTP ${status}${text ? `: ${text.slice(0, 200)}` : ""}`;
  const kind: HostErrorKind =
    (status === 503 && body?.error === SCHEMA_BEHIND) || /no such (table|column)/.test(message) ? "schema_behind"
    : status === 409 && /changed on disk/.test(message) ? "conflict"
    : status === 400 || status === 422 ? "validation"
    : status === 403 ? "forbidden"
    : status === 401 ? "unauthorized"
    : "error";
  return { kind, message };
}

/** Never throws: every failure is a typed `{ ok: false }` the editor must render. */
async function call<T>(init: RequestInit): Promise<HostResult<T>> {
  let res: Response;
  try {
    res = await fetch(URL, { ...init, headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), "X-Archangel-Token": csrfToken() } });
  } catch (e) {
    return { ok: false, error: { kind: "network", message: `network error: ${e instanceof Error ? e.message : String(e)}` } };
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: reported below with the status and the start of the body
  }
  if (!res.ok || body === null) return { ok: false, error: classify(res.status, body as { error?: string } | null, text) };
  return { ok: true, value: body as T };
}

export const loadHostConfig = () => call<HostConfigRead>({});
export const previewHostConfig = (baseSha256: string | null, rawText: string) =>
  call<PreviewResult>({ method: "POST", body: JSON.stringify({ mode: "preview", baseSha256, rawText }) });
export const applyHostConfig = (baseSha256: string | null, rawText: string, previewSha256: string, confirmLoosen: boolean) =>
  call<ApplyResult>({ method: "POST", body: JSON.stringify({ mode: "apply", baseSha256, rawText, previewSha256, confirmLoosen }) });
