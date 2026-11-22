import type { Ledger } from "../ledger/store.js";
import { formatAge, STAGES, type Stage, type UiItem } from "./ui-state.js";

/** The daemon renews its lock every 30s; the host default lease is 3 minutes. */
export const DAEMON_STALE_MS = 3 * 60_000;

export interface Health {
  daemon: { state: "running" | "stale" | "stopped"; heartbeatAgeMs: number | null };
  /** Repos whose workflow did not resolve (missing, invalid): intake, Scouts and autonomous landing are halted. */
  halted: Array<{ repo: string; status: string; error: string }>;
  stuckOutbox: Array<{ repo: string; effect: string; attempts: number; lastError: string | null }>;
  autonomyCapHit: string[];
  ok: boolean;
}

/** Read-only liveness and degradation signals that `archangel status` must not hide. */
export function computeHealth(ledger: Ledger, now: number, repos: string[]): Health {
  const beat = ledger.daemonHeartbeatAt();
  const daemon: Health["daemon"] =
    beat === null
      ? { state: "stopped", heartbeatAgeMs: null }
      : { state: now - beat < DAEMON_STALE_MS ? "running" : "stale", heartbeatAgeMs: Math.max(0, now - beat) };
  const halted: Health["halted"] = [];
  for (const c of ledger.listCachedWorkflows()) {
    const wf = c.workflow as { status?: string; error?: string } | null;
    if (!wf || typeof wf.status !== "string") halted.push({ repo: c.repo, status: "unreadable", error: "cached workflow is not valid JSON" });
    else if (wf.status !== "ok") halted.push({ repo: c.repo, status: wf.status, error: String(wf.error ?? "") });
  }
  const stuckOutbox = ledger.listStuckOutbox().map((o) => ({ repo: o.repo, effect: o.effect.kind, attempts: o.attempts, lastError: o.lastError }));
  const autonomyCapHit = repos.filter((r) => ledger.autonomyCapHitSinceOwner(r));
  return { daemon, halted, stuckOutbox, autonomyCapHit, ok: daemon.state === "running" && halted.length === 0 && stuckOutbox.length === 0 && autonomyCapHit.length === 0 };
}

/** Text lines for the Health block: problems are prefixed with `!` so they stand out. */
export function renderHealth(h: Health): string[] {
  const lines: string[] = ["Health:"];
  const d = h.daemon;
  lines.push(
    d.state === "running"
      ? `  Daemon:   running (heartbeat ${formatAge(d.heartbeatAgeMs ?? 0)} ago)`
      : d.state === "stale"
        ? `! Daemon:   NOT RUNNING? last heartbeat ${formatAge(d.heartbeatAgeMs ?? 0)} ago (expected every 30s)`
        : "! Daemon:   not running (no lock held); run `archangel start`",
  );
  for (const x of h.halted) lines.push(`! Policy:   ${x.repo} halted (workflow ${x.status}): ${x.error.slice(0, 200)}`);
  for (const o of h.stuckOutbox) lines.push(`! Outbox:   ${o.repo} ${o.effect} failed ${o.attempts}x${o.lastError ? `: ${o.lastError.slice(0, 120)}` : ""}`);
  for (const r of h.autonomyCapHit) lines.push(`! Autonomy: ${r} hit the autonomy cap; waiting for the owner`);
  if (h.ok) lines.push("  All clear.");
  lines.push("");
  return lines;
}

/**
 * Text for `archangel status`: Threads grouped by stage, in dashboard order, empty groups skipped.
 * "Needs you" is skipped here because the command prints it first, with class and recommendation.
 */
export function renderStages(stages: Record<Stage, UiItem[]>, now: number): string[] {
  const lines: string[] = [];
  for (const stage of STAGES) {
    if (stage === "Needs you") continue;
    const items = stages[stage];
    if (items.length === 0) continue;
    lines.push(`${stage} (${items.length}):`);
    for (const i of items) {
      const pr = i.prNumber ? `PR #${i.prNumber}` : "no PR";
      lines.push(`  ${i.repo}#${i.issueNumber}  [${i.phase}, ${formatAge(now - i.since)}]  ${pr}  ${i.title}`);
    }
    lines.push("");
  }
  return lines;
}
