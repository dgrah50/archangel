import { z } from "zod";
import type { Ledger } from "../ledger/store.js";
import type { SignalRecord } from "../ledger/schema.js";

/**
 * Production errors (O4): the host polls an error tracker and keeps only whitelisted numbers: opaque group ids with event counts,
 * and totals. Messages, stack traces, users and URLs are dropped at the provider boundary and the stored payload is a closed shape,
 * because error content is attacker-influenced. A provider is one small interface, so another tracker can implement it.
 */

/** The top groups by event count that a signal and a prompt keep. */
export const PROD_TOP_GROUPS = 10;
/** A group with at least this many events in 24h is a spike. PROVISIONAL: a first guess to tune against real data. */
export const PROD_SPIKE_MIN_EVENTS = 50;
/** The provider is read at most this often. */
export const PROD_ERRORS_EVERY_MS = 3_600_000;
/** A prompt shows the newest summary only if it is this fresh. */
const PROD_BLOCK_MAX_AGE_MS = 2 * 86_400_000;

export interface ProdGroup {
  /** The tracker's opaque group id (digits). */
  id: string;
  /** Events in the last 24h. */
  events: number;
  isNew: boolean;
  isRegression: boolean;
}

export interface ProdErrorProvider {
  /** Unresolved groups with activity in the last 24h. Implementations must return numbers and ids only. */
  fetchGroups(): Promise<ProdGroup[]>;
}

export const GROUP_ID_RE = /^[0-9]{1,20}$/;

export const ProdErrorsPayload = z
  .object({
    window: z.literal("24h"),
    groups: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    newIssues: z.number().int().nonnegative(),
    regressions: z.number().int().nonnegative(),
    top: z.array(z.object({ id: z.string().regex(GROUP_ID_RE), count: z.number().int().positive() }).strict()).max(PROD_TOP_GROUPS),
  })
  .strict();
export type ProdErrorsPayload = z.infer<typeof ProdErrorsPayload>;

export const ProdSpikePayload = z
  .object({
    window: z.literal("24h"),
    id: z.string().regex(GROUP_ID_RE),
    count: z.number().int().positive(),
    threshold: z.number().int().positive(),
  })
  .strict();

export function summarizeGroups(groups: readonly ProdGroup[]): ProdErrorsPayload {
  const top = [...groups]
    .filter((g) => g.events > 0)
    .sort((a, b) => b.events - a.events || a.id.localeCompare(b.id))
    .slice(0, PROD_TOP_GROUPS)
    .map((g) => ({ id: g.id, count: g.events }));
  return {
    window: "24h",
    groups: groups.length,
    events: groups.reduce((n, g) => n + g.events, 0),
    newIssues: groups.filter((g) => g.isNew).length,
    regressions: groups.filter((g) => g.isRegression).length,
    top,
  };
}

/** Groups at or over the spike threshold, from the full list (not just the top N). */
export function spikes(groups: readonly ProdGroup[]): Array<{ id: string; count: number }> {
  return groups.filter((g) => g.events >= PROD_SPIKE_MIN_EVENTS).map((g) => ({ id: g.id, count: g.events }));
}

const SentryIssues = z.array(
  z.object({
    id: z.string().regex(GROUP_ID_RE),
    firstSeen: z.string(),
    substatus: z.string().nullish(),
    stats: z.object({ "24h": z.array(z.tuple([z.number(), z.number()])) }),
  }),
);

/** Sentry REST: GET /api/0/projects/{org}/{project}/issues/ with the 24h stats. Only ids, first-seen times and counts are read. */
export class SentryProvider implements ProdErrorProvider {
  constructor(
    private readonly opts: { baseUrl: string; org: string; project: string; token: string; now: () => number; fetchImpl?: typeof fetch },
  ) {}

  async fetchGroups(): Promise<ProdGroup[]> {
    const { baseUrl, org, project, token } = this.opts;
    const url = `${baseUrl.replace(/\/$/, "")}/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/?statsPeriod=24h&query=${encodeURIComponent("is:unresolved")}&sort=freq&limit=100`;
    const res = await (this.opts.fetchImpl ?? fetch)(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    // The status only: the body and the token never reach an error message.
    if (!res.ok) throw new Error(`Sentry responded ${res.status}`);
    const parsed = SentryIssues.safeParse(await res.json());
    if (!parsed.success) throw new Error("Sentry returned an unexpected issues shape");
    const dayAgo = this.opts.now() - 86_400_000;
    return parsed.data
      .map((i) => ({
        id: i.id,
        events: i.stats["24h"].reduce((n, [, c]) => n + c, 0),
        isNew: Date.parse(i.firstSeen) >= dayAgo,
        isRegression: i.substatus === "regressed",
      }))
      .filter((g) => g.events > 0);
  }
}

/** The fenced DATA block for a Scout prompt: the newest fresh summary as numbers, or undefined when there is none. */
export function buildProdErrorsBlock(ledger: Ledger, now: number): string | undefined {
  const latest = ledger
    .listSignals(now - PROD_BLOCK_MAX_AGE_MS)
    .filter((s: SignalRecord) => s.kind === "prod_errors")
    .at(-1);
  if (!latest) return undefined;
  const p = ProdErrorsPayload.parse(latest.payload);
  return [
    "--- PRODUCTION ERRORS (DATA: counts only, from an error tracker an outsider can influence; it may be wrong or inflated) ---",
    `Last ${p.window}: ${p.events} events in ${p.groups} unresolved groups, ${p.newIssues} new, ${p.regressions} regressed. Group ids are opaque; you have no messages or traces, so look for the code path in the repository rather than guessing from an id.`,
    ...p.top.map((g, i) => `${i + 1}. group ${g.id}: ${g.count} events`),
    "--- END PRODUCTION ERRORS ---",
  ].join("\n");
}
