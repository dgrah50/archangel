import type { Ledger } from "../ledger/store.js";
import { PITCH_DECLINE_WINDOW_DAYS, PITCH_MAX_OPEN, PITCH_PAUSE_AFTER_UNPROMOTED, type PitchItem } from "./pitch.js";
import { PITCH_EXPIRY_DAYS } from "./pitch-expiry.js";
import { PitchStateSchema, isUndecided, type PitchState } from "./pitch-machine.js";

/** Read-only view for the Pitches page. Pitch text is model-written and untrusted: the UI renders it only as React children. */

const DAY_MS = 86_400_000;
const DECIDED_SHOWN = 8;

export interface PitchRow {
  repo: string;
  issueNumber: number;
  scoutName: string;
  filedAt: number;
  /** When the bot closes it if the owner never acts. */
  expiresAt: number;
  state: PitchState;
  pitch: PitchItem;
}

export interface PitchesState {
  generatedAt: number;
  expiryDays: number;
  declineWindowDays: number;
  maxOpen: number;
  pauseAfterUnpromoted: number;
  open: PitchRow[];
  decided: Array<{ repo: string; issueNumber: number; title: string; state: PitchState }>;
}

export function buildPitchesState(ledger: Ledger, now = Date.now()): PitchesState {
  const open: PitchRow[] = [];
  const decided: Array<PitchesState["decided"][number] & { stateAt: number }> = [];
  for (const r of ledger.listPitchRows()) {
    const state = PitchStateSchema.parse(JSON.parse(r.stateJson));
    if (isUndecided(state)) {
      // Validated by PitchOutputSchema when it was filed.
      open.push({ repo: r.repo, issueNumber: r.issueNumber, scoutName: r.scoutName, filedAt: r.filedAt, expiresAt: r.filedAt + PITCH_EXPIRY_DAYS * DAY_MS, state, pitch: JSON.parse(r.pitchJson) as PitchItem });
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
    open,
    decided: decided.slice(0, DECIDED_SHOWN).map(({ stateAt: _s, ...d }) => d),
  };
}
