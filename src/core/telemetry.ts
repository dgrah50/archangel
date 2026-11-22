import { checkTags, REPO_RE, type TelemetryName, type TelemetryTags } from "./telemetry-events.js";

/** Where telemetry rows go: the host Ledger. Local only; nothing here touches the network. */
export interface TelemetrySink {
  insertTelemetry(row: { ts: number; repo: string | null; name: string; value: number; tagsJson: string }): void;
}

/** Rows kept this long; older ones are pruned in batches. */
export const TELEMETRY_RETENTION_MS = 30 * 86_400_000;
export const TELEMETRY_PRUNE_BATCH = 5000;

let sink: TelemetrySink | null = null;
let dropped = 0;
let lastDrop: string | null = null;

/** The daemon points telemetry at its Ledger once; without a sink (tests, CLI commands) `emit` does nothing. */
export function setTelemetrySink(next: TelemetrySink | null): void {
  sink = next;
}

/** Events that failed validation or the write and were dropped since start, and why the latest one was. */
export function telemetryDropped(): { count: number; last: string | null } {
  return { count: dropped, last: lastDrop };
}

/** Records one event. Never throws and never retries: any failure counts and drops, so telemetry cannot slow or break a tick. */
export function emit<N extends TelemetryName>(name: N, value: number, tags: TelemetryTags<N>, repo: string | null = null): void {
  if (!sink) return;
  try {
    if (!Number.isFinite(value)) throw new Error("telemetry value must be finite");
    if (repo !== null && !REPO_RE.test(repo)) throw new Error("telemetry repo must be owner/name");
    sink.insertTelemetry({ ts: Date.now(), repo, name, value, tagsJson: JSON.stringify(checkTags(name, tags)) });
  } catch (err) {
    dropped++;
    lastDrop = err instanceof Error ? err.message : String(err);
  }
}

/** Times one reviewer run: records its latency with the verdict it gave (or "error" when it threw), and passes the outcome through untouched. */
export async function timeReview<T extends { verdict: "approve" | "veto" }>(vendor: TelemetryTags<"review_ms">["vendor"], run: Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await run;
    emit("review_ms", Date.now() - t0, { vendor, verdict: result.verdict });
    return result;
  } catch (err) {
    emit("review_ms", Date.now() - t0, { vendor, verdict: "error" });
    throw err;
  }
}
