import type { ScoutSpec } from "./workflow.js";

/**
 * Fleet Scouts: bundled with Archangel, enabled per machine by `fleetScouts` in archangel.yaml, and run on every
 * watched repo unless that repo's `.agents/archangel.json` opts out. The repo never carries a copy. They are
 * always `promotion: "owner"`; nothing a repo or a prompt says can loosen that.
 */
export const FLEET_SCOUT_NAMES = ["anti-slop-bugs", "anti-slop-cleanup"] as const;
export type FleetScoutName = (typeof FLEET_SCOUT_NAMES)[number];

export const FLEET_SCOUTS: Record<FleetScoutName, { spec: ScoutSpec; prompt: string }> = {
  // Files testable defects only: each becomes a normal bug issue that must pass red-on-base.
  "anti-slop-bugs": {
    spec: {
      name: "anti-slop-bugs",
      kind: "bug",
      schedule: "weekly",
      maxProposals: 2,
      skills: ["general/bug-hunt", "general/implicit-state-machines", "general/error-handling", "general/input-validation"],
      includeMetrics: false,
      promotion: "owner",
    },
    prompt: "Hunt for hygiene defects in the repository's production source: swallowed errors, silent fallbacks, unchecked input, implicit state machines.\nOnly file a defect that has a new test failing on main today.\n",
  },
  // Pitches structural removals only; goes through the pitch flow (critic, owner promotion, caps).
  "anti-slop-cleanup": {
    spec: {
      name: "anti-slop-cleanup",
      kind: "pitch",
      schedule: "weekly",
      maxProposals: 1,
      skills: ["general/pitch", "general/removal", "general/repeated-work"],
      includeMetrics: false,
      promotion: "owner",
    },
    prompt: "Pitch at most one evidence-backed removal or de-duplication: dead code, copies that must change together, single-caller abstractions, redundant tests.\nIf there is none worth the owner's time, pitch nothing.\n",
  },
};
