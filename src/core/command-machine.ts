import { z } from "zod";

export const CommandStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("claimed"), at: z.number().int() }),
  z.object({ kind: z.literal("completed"), result: z.unknown() }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
  z.object({ kind: z.literal("cancelled"), reason: z.string() }),
]);
export type CommandState = z.infer<typeof CommandStateSchema>;

export type CommandEvent =
  | { t: "claim"; at: number }
  | { t: "complete"; result: unknown }
  | { t: "fail"; error: string }
  | { t: "cancel"; reason: string };

export type CommandStep = { ok: true; next: CommandState } | { ok: false; reject: string };

export function stepCommand(state: CommandState, ev: CommandEvent): CommandStep {
  const reject = (why: string): CommandStep => ({ ok: false, reject: `${ev.t} is not allowed in ${state.kind}: ${why}` });
  switch (ev.t) {
    case "claim":
      return state.kind === "pending" ? { ok: true, next: { kind: "claimed", at: ev.at } } : reject("only a pending command can be claimed");
    case "complete":
      return state.kind === "claimed" ? { ok: true, next: { kind: "completed", result: ev.result } } : reject("only the daemon's claimed command can complete");
    case "fail":
      return state.kind === "claimed" ? { ok: true, next: { kind: "failed", error: ev.error } } : reject("only the daemon's claimed command can fail");
    case "cancel":
      return state.kind === "pending" ? { ok: true, next: { kind: "cancelled", reason: ev.reason } } : reject("a claimed or finished command cannot be cancelled");
  }
}
