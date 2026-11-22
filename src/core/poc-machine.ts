import { z } from "zod";

/** Why a PoC build ended without a ref. A fixed set: the dashboard shows a sentence per category, never raw agent text. */
export const POC_FAILURE_CATEGORIES = ["over_budget", "provider_unavailable", "implementer_failed", "setup_failed", "empty", "out_of_bounds", "aborted", "internal"] as const;

/** Running and stopped come later, with the sandboxed runner. */
export const PocStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("building"), since: z.number().int() }),
  z.object({ kind: z.literal("ready"), headSha: z.string().regex(/^[0-9a-f]{40}$/), builtAt: z.number().int() }),
  z.object({ kind: z.literal("failed"), category: z.enum(POC_FAILURE_CATEGORIES), at: z.number().int() }),
]);
export type PocState = z.infer<typeof PocStateSchema>;

export type PocEvent =
  | { t: "build_requested"; at: number }
  | { t: "built"; headSha: string; at: number }
  | { t: "build_failed"; category: (typeof POC_FAILURE_CATEGORIES)[number]; at: number };

export type PocStep = { ok: true; next: PocState } | { ok: false; reject: string };

/** Pure. A build starts from anywhere but `building` (a rebuild replaces `ready` or `failed`; the caps bound how often), and only a build in progress ends. */
export function stepPoc(state: PocState, ev: PocEvent): PocStep {
  const reject = (why: string): PocStep => ({ ok: false, reject: `${ev.t} is not allowed in ${state.kind}: ${why}` });
  switch (ev.t) {
    case "build_requested":
      return state.kind === "building" ? reject("a build is already running") : { ok: true, next: { kind: "building", since: ev.at } };
    case "built":
      return state.kind === "building" ? { ok: true, next: { kind: "ready", headSha: ev.headSha, builtAt: ev.at } } : reject("no build is running");
    case "build_failed":
      return state.kind === "building" ? { ok: true, next: { kind: "failed", category: ev.category, at: ev.at } } : reject("no build is running");
  }
}
