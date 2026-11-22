import crypto from "node:crypto";
import { z } from "zod";
import { REPO_SLUG_RE } from "../config.js";
import { applyPlan, buildPlan, type OnboardPlan, type OnboardRunner } from "./onboard.js";
import { ProposeRefusal } from "./ui-propose.js";

/**
 * W3: the dashboard's onboarding route. It only calls `buildPlan()` and `applyPlan()` from onboard.ts, so the only GitHub writes
 * are labels, the `chore/archangel-onboard` branch and one unmerged PR. `apply` applies exactly the plan a recent `plan` returned
 * (identified by hash), and is audited BEFORE any write (an audit failure means nothing is written).
 */
export const PLAN_TTL_MS = 10 * 60_000;

export interface OnboardDeps {
  runner: OnboardRunner;
  /** Writes one audit row (never actor `owner`). Must throw on failure. */
  audit: (topic: string, payload: Record<string, unknown>, now: number) => void;
  now?: () => number;
}

const Body = z.object({
  mode: z.enum(["plan", "apply"]),
  planSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export interface PlanResult {
  mode: "plan";
  plan: OnboardPlan;
  planSha256: string;
}
export interface ApplyResult {
  mode: "apply";
  repo: string;
  log: string[];
}

const hashPlan = (p: OnboardPlan): string => crypto.createHash("sha256").update(JSON.stringify(p)).digest("hex");

/** Stateful because `apply` must match a recent `plan` for the same repo made by this process. */
export function makeOnboardHandler(deps: OnboardDeps) {
  const now = deps.now ?? Date.now;
  const plans = new Map<string, { plan: OnboardPlan; hash: string; at: number }>();

  return async (repo: string, raw: unknown): Promise<PlanResult | ApplyResult> => {
    if (!REPO_SLUG_RE.test(repo)) throw new ProposeRefusal(400, "repo must be owner/name");
    const parsed = Body.safeParse(raw);
    if (!parsed.success) throw new ProposeRefusal(400, `invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const b = parsed.data;
    if (b.mode === "plan") {
      let plan: OnboardPlan;
      try {
        plan = await buildPlan(deps.runner, repo);
      } catch (err) {
        throw new ProposeRefusal(502, err instanceof Error ? err.message : String(err));
      }
      const hash = hashPlan(plan);
      for (const [k, v] of plans) if (now() - v.at > PLAN_TTL_MS) plans.delete(k);
      plans.set(repo, { plan, hash, at: now() });
      return { mode: "plan", plan, planSha256: hash };
    }
    const seen = plans.get(repo);
    if (b.planSha256 === undefined || !seen || seen.hash !== b.planSha256 || now() - seen.at > PLAN_TTL_MS) {
      throw new ProposeRefusal(409, "no recent plan with this hash for this repo: plan it again");
    }
    plans.delete(repo); // a replay needs a fresh plan
    deps.audit("onboard/apply", { repo, planSha256: seen.hash, files: seen.plan.files.map((f) => f.path), labelsToCreate: seen.plan.labelsToCreate }, now());
    const log: string[] = [];
    try {
      await applyPlan(deps.runner, seen.plan, (s) => log.push(s));
    } catch (err) {
      throw new ProposeRefusal(502, `${err instanceof Error ? err.message : String(err)} (applied so far: ${log.join("; ") || "nothing"}; plan again to retry, it is idempotent)`);
    }
    return { mode: "apply", repo, log };
  };
}
