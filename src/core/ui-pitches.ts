import { z } from "zod";
import type { Ledger } from "../ledger/store.js";
import { PITCH_DECLINE_WINDOW_DAYS, PITCH_MAX_OPEN, PITCH_PAUSE_AFTER_UNPROMOTED, type PitchItem } from "./pitch.js";
import { PITCH_EXPIRY_DAYS } from "./pitch-expiry.js";
import { scoutNextDueAt } from "./scout.js";
import { PitchStateSchema, isUndecided, type PitchState } from "./pitch-machine.js";

/** Read-only view for the Pitches page. Pitch text is model-written and untrusted: the UI renders it only as React children. */

const DAY_MS = 86_400_000;
const DECIDED_SHOWN = 8;

/** A host-validated image stored for a pitch; the bytes are served by `/api/pitch-asset/<sha256>`. `path` is the repo file it came from. */
const AttachmentSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.literal("repo"),
    mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    caption: z.string(),
    source: z.string().min(3),
  })
  .strict()
  .transform(({ source, ...a }) => ({ ...a, path: source.slice(0, source.lastIndexOf("@")) }));
export type PitchAttachment = z.output<typeof AttachmentSchema>;

export interface PitchRow {
  repo: string;
  issueNumber: number;
  scoutName: string;
  filedAt: number;
  /** When the bot closes it if the owner never acts. */
  expiresAt: number;
  state: PitchState;
  pitch: PitchItem;
  attachments: PitchAttachment[];
}

/** One repo's pitch Scout, from its cached effective workflow; `scout` is null when the repo declares none. */
export interface PitchScoutInfo {
  repo: string;
  scout: null | {
    name: string;
    schedule: "daily" | "weekly" | "manual";
    /** Weekly only: last run + 7 days, or now when due on the next daemon pass. Null for daily (every pass, capped per day) and manual (never automatic). */
    nextRunAt: number | null;
    /** Scouts are switched off on this host: nothing runs. */
    hostDisabled: boolean;
    paused: boolean;
    /** Latest pitches in a row (this Scout version) that were not promoted, counted up to `pauseAfterUnpromoted`. */
    unpromotedInARow: number;
  };
}

export interface PitchesState {
  generatedAt: number;
  expiryDays: number;
  declineWindowDays: number;
  maxOpen: number;
  pauseAfterUnpromoted: number;
  pitchScouts: PitchScoutInfo[];
  open: PitchRow[];
  decided: Array<{ repo: string; issueNumber: number; title: string; state: PitchState }>;
}

const ScheduleSchema = z.enum(["daily", "weekly", "manual"]);
/** The cached workflow is untrusted JSON from system_state: only these fields are read, and only from an `ok` workflow. */
const CachedPitchScouts = z
  .object({
    status: z.literal("ok"),
    scouts: z.array(z.object({ name: z.string(), kind: z.string(), schedule: ScheduleSchema, trustHash: z.string() }).passthrough()),
    caps: z.object({ scoutsEnabled: z.boolean() }).passthrough(),
  })
  .passthrough();

function pitchScouts(ledger: Ledger, now: number): PitchScoutInfo[] {
  const out: PitchScoutInfo[] = [];
  for (const c of ledger.listCachedWorkflows()) {
    const wf = CachedPitchScouts.safeParse(c.workflow);
    if (!wf.success) continue;
    const s = wf.data.scouts.find((x) => x.kind === "pitch");
    out.push({
      repo: c.repo,
      scout: s
        ? {
            name: s.name,
            schedule: s.schedule,
            nextRunAt: scoutNextDueAt(s.schedule, ledger.lastScoutRunAt(s.name, c.repo), now),
            hostDisabled: !wf.data.caps.scoutsEnabled,
            paused: ledger.isPitchScoutPaused(s.name, s.trustHash, PITCH_PAUSE_AFTER_UNPROMOTED, c.repo),
            unpromotedInARow: ledger.pitchUnpromotedStreak(s.name, s.trustHash, PITCH_PAUSE_AFTER_UNPROMOTED, c.repo),
          }
        : null,
    });
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo));
}

export function buildPitchesState(ledger: Ledger, now = Date.now()): PitchesState {
  const open: PitchRow[] = [];
  const decided: Array<PitchesState["decided"][number] & { stateAt: number }> = [];
  const attachments = new Map<string, PitchAttachment[]>();
  for (const { repo, issueNumber, ...a } of ledger.listPitchAttachments()) {
    const key = `${repo}#${issueNumber}`;
    attachments.set(key, [...(attachments.get(key) ?? []), AttachmentSchema.parse(a)]);
  }
  for (const r of ledger.listPitchRows()) {
    const state = PitchStateSchema.parse(JSON.parse(r.stateJson));
    if (isUndecided(state)) {
      // Validated by PitchOutputSchema when it was filed.
      open.push({ repo: r.repo, issueNumber: r.issueNumber, scoutName: r.scoutName, filedAt: r.filedAt, expiresAt: r.filedAt + PITCH_EXPIRY_DAYS * DAY_MS, state, pitch: JSON.parse(r.pitchJson) as PitchItem, attachments: attachments.get(`${r.repo}#${r.issueNumber}`) ?? [] });
    } else {
      decided.push({ repo: r.repo, issueNumber: r.issueNumber, title: r.title, state, stateAt: r.stateAt });
    }
  }
  decided.sort((a, b) => b.stateAt - a.stateAt);
  return {
    generatedAt: now,
    expiryDays: PITCH_EXPIRY_DAYS,
    declineWindowDays: PITCH_DECLINE_WINDOW_DAYS,
    maxOpen: PITCH_MAX_OPEN,
    pauseAfterUnpromoted: PITCH_PAUSE_AFTER_UNPROMOTED,
    pitchScouts: pitchScouts(ledger, now),
    open,
    decided: decided.slice(0, DECIDED_SHOWN).map(({ stateAt: _s, ...d }) => d),
  };
}
