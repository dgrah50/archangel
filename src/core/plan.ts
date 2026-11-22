import crypto from "node:crypto";
import { z } from "zod";
import { scanForSecrets } from "./secrets.js";

/** PROVISIONAL: the roadmap gates plan approval on evidence (3 feature Threads ending badly); until it exists these bounds are guesses to tune from the audit rows. */
export const PLAN_MAX_CHARS = 6_000;
/** PROVISIONAL: plans the factory writes per Thread before it asks the owner what to do; each owner retry grants one more. */
export const PLAN_ROUNDS_PER_THREAD = 2;

/** The plan is model-written text: bounded and non-trivial, nothing more. It is data for the owner to read, never an instruction to the daemon. */
const PlanTextSchema = z.string().trim().min(40, "plan is too short to be a plan").max(PLAN_MAX_CHARS, `plan is over ${PLAN_MAX_CHARS} characters`);

export function vetPlan(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
  const parsed = PlanTextSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues.map((i) => i.message).join("; ") };
  const secret = scanForSecrets(parsed.data);
  if (secret !== null) return { ok: false, reason: `plan held a secret-like string (${secret}), so it was not posted` };
  return { ok: true, text: parsed.data };
}

export const planSha256 = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** The issue comment for a plan: labelled as machine-written, with @-mentions defused so model text cannot ping anyone. */
export function renderPlanComment(input: { version: number; sha256: string; text: string; approvalLabel: string }): string {
  const safe = input.text.replace(/@(?=[\w-])/g, "@\u200b");
  return [
    `**Archangel plan v${input.version}** (machine-written by the factory, not by the repository owner; sha256 \`${input.sha256.slice(0, 12)}\`)`,
    "",
    ...safe.split("\n").map((l) => `> ${l}`),
    "",
    `To approve exactly this plan, apply the \`${input.approvalLabel}\` label. To change it, comment what it should say and the factory will re-plan (at most ${PLAN_ROUNDS_PER_THREAD} plans, then it asks you). Nothing is implemented until you approve.`,
  ].join("\n");
}
