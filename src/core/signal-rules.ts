import crypto from "node:crypto";
import { z } from "zod";
import type { SignalTaint } from "../ledger/schema.js";
import { SIGNAL_KINDS, type SignalKind } from "./signal-kinds.js";

/** Owner-written signal rules: which signals trigger which actions, and the one trust rule that bounds them. */
const KIND_NAMES = Object.keys(SIGNAL_KINDS) as [SignalKind, ...SignalKind[]];

export const SIGNAL_ACTIONS = ["file_issue", "run_scout", "run_pitch"] as const;
export type SignalAction = (typeof SIGNAL_ACTIONS)[number];

/**
 * The trust rule, in one place: only owner and mechanical signals may lead to write work (a filed issue, an arbitrary Scout);
 * an untrusted signal may only start a pitch run. Checked when the config loads and again when a rule is evaluated.
 */
export function actionAllowed(taint: SignalTaint, action: SignalAction): boolean {
  return taint !== "untrusted" || action === "run_pitch";
}

const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "use lowercase letters, digits and '-'");

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("file_issue"), class: z.enum(["bug", "chore"]), title: z.string().min(5).max(80) }).strict(),
  z.object({ action: z.literal("run_scout"), scout: Name }).strict(),
  z.object({ action: z.literal("run_pitch"), scout: Name }).strict(),
]);

export const SignalRuleSchema = z
  .object({
    name: Name,
    /** The signal kind this rule matches. */
    on: z.enum(KIND_NAMES),
    /** Only signals of this repo (`owner/name`, a project in this file); absent means every project. */
    repo: z.string().min(1).optional(),
    /** For `on: schedule`: the schedule name to match; absent means any schedule. */
    schedule: Name.optional(),
    do: ActionSchema,
    maxPerDay: z.number().int().min(1).max(10).default(1),
  })
  .strict();
export type SignalRule = z.infer<typeof SignalRuleSchema>;

export const SignalsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Hard cap on actions per day across all rules and projects. */
    maxActionsPerDay: z.number().int().min(1).max(50).default(5),
    schedules: z.array(z.object({ name: Name, every: z.enum(["daily", "weekly"]) }).strict()).default([]),
    rules: z.array(SignalRuleSchema).default([]),
  })
  .strict()
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.rules.forEach((r, i) => {
      if (seen.has(r.name)) ctx.addIssue({ code: "custom", path: ["rules", i, "name"], message: `duplicate rule '${r.name}'` });
      seen.add(r.name);
      if (!actionAllowed(SIGNAL_KINDS[r.on].taint, r.do.action)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", i, "do", "action"],
          message: `rule '${r.name}': '${r.on}' signals are untrusted and may only start a pitch run (run_pitch), never '${r.do.action}'`,
        });
      }
      if (r.schedule !== undefined && r.on !== "schedule") ctx.addIssue({ code: "custom", path: ["rules", i, "schedule"], message: "schedule only applies to `on: schedule`" });
      if (r.on === "schedule" && r.schedule !== undefined && !s.schedules.some((x) => x.name === r.schedule)) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "schedule"], message: `no schedule named '${r.schedule}'` });
      }
    });
  });
export type SignalsConfig = z.infer<typeof SignalsConfigSchema>;

/** Identity of a rule's behavior: editing a rule changes it, so the next tick reconsiders signals it already saw. */
export function ruleKey(rule: SignalRule): string {
  return crypto.createHash("sha256").update(JSON.stringify(rule)).digest("hex").slice(0, 16);
}

/** One line per rule for the dashboard. */
export function describeRule(r: SignalRule): string {
  const act =
    r.do.action === "file_issue" ? `file a ${r.do.class} issue` : r.do.action === "run_scout" ? `run Scout ${r.do.scout}` : `run pitch Scout ${r.do.scout}`;
  return `${r.on}${r.schedule ? ` (${r.schedule})` : ""} -> ${act}, max ${r.maxPerDay}/day`;
}
