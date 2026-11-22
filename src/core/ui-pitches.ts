import { z } from "zod";
import { Ledger } from "../ledger/store.js";
import { PITCH_DECLINE_WINDOW_DAYS, PITCH_MAX_OPEN, PITCH_PAUSE_AFTER_UNPROMOTED, type PitchItem } from "./pitch.js";
import { PITCH_EXPIRY_DAYS } from "./pitch-expiry.js";
import { scoutNextDueAt } from "./scout.js";
import type { PocState } from "./poc-machine.js";
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

/** A pitch's proof of concept, for the "Try it" block. The preview URL is never here: nothing runs it yet, and it will live in daemon memory. */
export interface PitchPoc {
  state: PocState;
  builds: number;
  /** `git diff --stat` of the ref against the main tip it was built from; null until a build finishes. */
  diffStat: string | null;
}

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
  /** Null when no build was ever requested for this pitch. */
  poc: PitchPoc | null;
  /** The repo's policy file declares a `preview` block, so a PoC could be run. */
  hasPreview: boolean;
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
  pocMaxBuildsPerPitch: number;
  pocMaxBuildsPerDay: number;
  pocBuildsToday: number;
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
    preview: z.unknown().optional(),
  })
  .passthrough();

function reposWithPreview(ledger: Ledger): Set<string> {
  const out = new Set<string>();
  for (const c of ledger.listCachedWorkflows()) {
    const wf = CachedPitchScouts.safeParse(c.workflow);
    if (wf.success && wf.data.preview != null) out.add(c.repo);
  }
  return out;
}

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
  const pocs = new Map(ledger.listPocs().map((p) => [`${p.repo}#${p.issueNumber}`, p]));
  const previewRepos = reposWithPreview(ledger);
  for (const r of ledger.listPitchRows()) {
    const state = PitchStateSchema.parse(JSON.parse(r.stateJson));
    if (isUndecided(state)) {
      // Validated by PitchOutputSchema when it was filed.
      open.push({ repo: r.repo, issueNumber: r.issueNumber, scoutName: r.scoutName, filedAt: r.filedAt, expiresAt: r.filedAt + PITCH_EXPIRY_DAYS * DAY_MS, state, pitch: JSON.parse(r.pitchJson) as PitchItem, attachments: attachments.get(`${r.repo}#${r.issueNumber}`) ?? [], poc: pocRow(pocs.get(`${r.repo}#${r.issueNumber}`)), hasPreview: previewRepos.has(r.repo) });
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
    pocMaxBuildsPerPitch: Ledger.POC_MAX_BUILDS_PER_PITCH,
    pocMaxBuildsPerDay: Ledger.POC_MAX_BUILDS_PER_DAY,
    pocBuildsToday: ledger.pocBuildsInLastDay(now),
    pitchScouts: pitchScouts(ledger, now),
    open,
    decided: decided.slice(0, DECIDED_SHOWN).map(({ stateAt: _s, ...d }) => d),
  };
}

/** A pitch nobody asked a build for has a queued `none` row at most: that is no PoC yet. */
function pocRow(p: ReturnType<Ledger["listPocs"]>[number] | undefined): PitchPoc | null {
  return p && (p.builds > 0 || p.state.kind !== "none") ? { state: p.state, builds: p.builds, diffStat: p.diffStat } : null;
}
