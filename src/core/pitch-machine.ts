import { z } from "zod";

export const PitchStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open") }),
  z.object({
    kind: z.literal("partially_promoted"),
    promotedSlices: z.array(z.number().int().nonnegative()).min(1),
    totalSlices: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("promoted"), promotedSlices: z.array(z.number().int().nonnegative()).min(1) }),
  z.object({ kind: z.literal("declined"), reason: z.string().nullable() }),
  z.object({ kind: z.literal("expired"), expiredAt: z.number().int() }),
]);
export type PitchState = z.infer<typeof PitchStateSchema>;
export type PitchStateKind = PitchState["kind"];

export const PITCH_STATE_KINDS = ["open", "partially_promoted", "promoted", "declined", "expired"] as const satisfies readonly PitchStateKind[];

export type PitchEvent =
  | { t: "slices_promoted"; slices: number[]; total: number }
  | { t: "closed" }
  | { t: "decline_reason"; reason: string }
  | { t: "expired"; at: number };

export type PitchStep = { ok: true; next: PitchState } | { ok: false; reject: string };

export function isUndecided(s: PitchState): s is Extract<PitchState, { kind: "open" | "partially_promoted" }> {
  return s.kind === "open" || s.kind === "partially_promoted";
}

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
      if (state.kind === "partially_promoted") return { ok: true, next: { kind: "promoted", promotedSlices: state.promotedSlices } };
      return reject("the pitch is already decided");
    case "decline_reason":
      return state.kind === "declined" ? { ok: true, next: { kind: "declined", reason: ev.reason } } : reject("only a declined pitch has a decline reason");
  }
}
