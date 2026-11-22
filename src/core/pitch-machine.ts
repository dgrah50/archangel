import { z } from "zod";

/**
 * The pitch lifecycle as an explicit state machine (modelled on thread-machine.ts): a discriminated union validated by zod, a pure
 * transition function that rejects illegal moves, and a CAS version on the row. Every other representation (`status`, `expired_at`,
 * `decline_reason`, `promoted_slices`) used to be a separate column that could contradict the others.
 */
export const PitchStateSchema = z.discriminatedUnion("kind", [
  /** Filed, nobody has decided. */
  z.object({ kind: z.literal("open") }),
  /** Some slices became owner-authored issues; the pitch issue stays open for the rest. */
  z.object({
    kind: z.literal("partially_promoted"),
    promotedSlices: z.array(z.number().int().nonnegative()).min(1),
    totalSlices: z.number().int().positive(),
  }),
  /** Every slice promoted, or the pitch was closed after at least one was. */
  z.object({ kind: z.literal("promoted"), promotedSlices: z.array(z.number().int().nonnegative()).min(1) }),
  /** Closed by the owner (or otherwise) with nothing promoted. */
  z.object({ kind: z.literal("declined"), reason: z.string().nullable() }),
  /** Closed by the bot after the expiry window with no owner action. */
  z.object({ kind: z.literal("expired"), expiredAt: z.number().int() }),
]);
export type PitchState = z.infer<typeof PitchStateSchema>;
export type PitchStateKind = PitchState["kind"];

export const PITCH_STATE_KINDS = ["open", "partially_promoted", "promoted", "declined", "expired"] as const satisfies readonly PitchStateKind[];

export type PitchEvent =
  | { t: "slices_promoted"; slices: number[]; total: number }
  /** The pitch issue is no longer open. */
  | { t: "closed" }
  | { t: "decline_reason"; reason: string }
  | { t: "expired"; at: number };

export type PitchStep = { ok: true; next: PitchState } | { ok: false; reject: string };

/** Open or partially promoted: the pitch issue is still open and counts toward caps, the digest, expiry and close detection. */
export function isUndecided(s: PitchState): s is Extract<PitchState, { kind: "open" | "partially_promoted" }> {
  return s.kind === "open" || s.kind === "partially_promoted";
}

/** For the Scout's pause rule: any promotion counts, even if the rest of the slices were never promoted. */
export function countsAsPromoted(s: PitchState): boolean {
  return s.kind === "promoted" || s.kind === "partially_promoted";
}

export function promotedSlicesOf(s: PitchState): number[] {
  return s.kind === "partially_promoted" || s.kind === "promoted" ? s.promotedSlices : [];
}

const sorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

export function stepPitch(state: PitchState, ev: PitchEvent): PitchStep {
  const reject = (why: string): PitchStep => ({ ok: false, reject: `${ev.t} is not allowed in ${state.kind}: ${why}` });
  switch (ev.t) {
    case "slices_promoted": {
      if (!isUndecided(state)) return reject("the pitch is already decided");
      if (ev.slices.length === 0) return reject("no slices given");
      if (ev.slices.some((i) => i < 0 || i >= ev.total)) return reject(`slice index outside 0..${ev.total - 1}`);
      const have = promotedSlicesOf(state);
      if (ev.slices.some((i) => have.includes(i))) return reject("a slice is already promoted");
      const all = sorted([...have, ...ev.slices]);
      return {
        ok: true,
        next: all.length === ev.total ? { kind: "promoted", promotedSlices: all } : { kind: "partially_promoted", promotedSlices: all, totalSlices: ev.total },
      };
    }
    case "closed":
      if (state.kind === "open") return { ok: true, next: { kind: "declined", reason: null } };
      if (state.kind === "partially_promoted") return { ok: true, next: { kind: "promoted", promotedSlices: state.promotedSlices } };
      return reject("the pitch is already decided");
    case "expired":
      if (state.kind === "open") return { ok: true, next: { kind: "expired", expiredAt: ev.at } };
      // The bot closing a pitch the owner only partly worked through leaves what was promoted as promoted.
      if (state.kind === "partially_promoted") return { ok: true, next: { kind: "promoted", promotedSlices: state.promotedSlices } };
      return reject("the pitch is already decided");
    case "decline_reason":
      return state.kind === "declined" ? { ok: true, next: { kind: "declined", reason: ev.reason } } : reject("only a declined pitch has a decline reason");
  }
}
