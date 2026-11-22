import { z } from "zod";
import type { GitHubClient } from "../github/client.js";
import { formatDayKey, type Ledger } from "../ledger/store.js";
import { SIGNAL_KINDS, type SignalKind } from "./signal-kinds.js";

/** Signals older than this are never actioned, and an adapter with no watermark reads back this far. */
export const SIGNAL_LOOKBACK_MS = 7 * 86_400_000;
/** An adapter polls GitHub at most this often. */
export const SIGNAL_POLL_MS = 10 * 60_000;

/** Closed payload shapes: numbers, enums and tightly patterned tokens only. Free text from outside (titles, descriptions) never enters a signal. */
const PAYLOADS = {
  pr_merged: z.object({ number: z.number().int().positive() }).strict(),
  release: z.object({ tag: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,99}$/) }).strict(),
  advisory: z
    .object({
      number: z.number().int().positive(),
      severity: z.enum(["low", "medium", "high", "critical"]),
      ghsaId: z.string().regex(/^GHSA(-[a-z0-9]{4}){3}$/),
    })
    .strict(),
  schedule: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), slot: z.string().regex(/^[0-9a-zA-Z-]{1,20}$/) }).strict(),
} as const satisfies Record<SignalKind, z.ZodType>;

/** Appends one signal; false when this event was already ingested. Source and taint come from the kind, not from the caller. */
export function recordSignal(ledger: Ledger, kind: SignalKind, eventId: string, payload: unknown, observedAt: number): boolean {
  const { source, taint } = SIGNAL_KINDS[kind];
  return ledger.insertSignal({
    repo: ledger.repo,
    source,
    kind,
    dedupeKey: `${ledger.repo}:${kind}:${eventId}`,
    taint,
    payload: PAYLOADS[kind].parse(payload),
    observedAt,
  });
}

function weeklySlot(now: number): string {
  return `w${Math.floor((Math.floor(now / 86_400_000) + 3) / 7)}`;
}

/**
 * Reads each adapter forward from its watermark into the `signals` table. Idempotent: a repeated or overlapping read adds nothing.
 * One adapter failing is reported and does not stop the others; its watermark stays put, so the next poll catches up.
 */
export async function ingestSignals(opts: {
  ledger: Ledger;
  github: GitHubClient;
  defaultBranch: string;
  /** Kinds somebody listens to: the others are not polled. */
  wanted: ReadonlySet<SignalKind>;
  schedules: ReadonlyArray<{ name: string; every: "daily" | "weekly" }>;
  now: number;
  onError: (adapter: string, err: unknown) => void;
}): Promise<void> {
  const { ledger, github, now, wanted } = opts;

  for (const s of opts.schedules) {
    const slot = s.every === "daily" ? formatDayKey(now, ledger.dayTimeZone) : weeklySlot(now);
    recordSignal(ledger, "schedule", `${s.name}:${slot}`, { name: s.name, slot }, now);
  }

  const poll = async (adapter: string, kind: SignalKind, read: (since: number) => Promise<Array<{ at: number; eventId: string; payload: unknown }>>) => {
    if (!wanted.has(kind)) return;
    const mark = ledger.getSignalWatermark(adapter);
    if (mark && now - mark.polledAt < SIGNAL_POLL_MS) return;
    try {
      let watermark = mark?.watermark ?? now - SIGNAL_LOOKBACK_MS;
      for (const ev of await read(watermark)) {
        recordSignal(ledger, kind, ev.eventId, ev.payload, ev.at);
        watermark = Math.max(watermark, ev.at);
      }
      ledger.setSignalWatermark(adapter, watermark, now);
    } catch (err) {
      opts.onError(adapter, err);
    }
  };

  await poll("github:pr_merged", "pr_merged", async (since) =>
    (await github.listMergedPrsSince(since, opts.defaultBranch)).map((p) => ({ at: p.mergedAt, eventId: String(p.number), payload: { number: p.number } })),
  );
  await poll("github:release", "release", async (since) =>
    (await github.listReleasesSince(since)).flatMap((r) => (PAYLOADS.release.safeParse({ tag: r.tag }).success ? [{ at: r.publishedAt, eventId: r.tag, payload: { tag: r.tag } }] : [])),
  );
  await poll("github_advisory:advisory", "advisory", async (since) =>
    (await github.listDependabotAlertsSince(since)).map((a) => ({
      at: a.createdAt,
      eventId: String(a.number),
      payload: { number: a.number, severity: a.severity, ghsaId: a.ghsaId },
    })),
  );
}
