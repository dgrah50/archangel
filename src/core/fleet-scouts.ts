import type { ScoutSpec } from "./workflow.js";

/**
 * Fleet Scouts: bundled with Archangel, enabled per machine by `fleetScouts` in archangel.yaml, and run on every
 * watched repo unless that repo's `.agents/archangel.json` opts out. The repo never carries a copy. They are
 * always `promotion: "owner"`; nothing a repo or a prompt says can loosen that.
 */
export const FLEET_SCOUT_NAMES = ["anti-slop-bugs", "anti-slop-cleanup", "fleet-pr-miner"] as const;
/** The cross-repo miner: the runner feeds it fleet-wide Ledger data and merged-commit history instead of only the usual metrics. */
export const FLEET_MINER_NAME = "fleet-pr-miner";
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
  // Mines merged history, Ledger outcomes and Scout yields for pitches about Skills, Scouts and Archangel itself. Pitch-only.
  "fleet-pr-miner": {
    spec: {
      name: "fleet-pr-miner",
      kind: "pitch",
      schedule: "weekly",
      maxProposals: 1,
      skills: ["general/pitch", "general/fleet-mining"],
      includeMetrics: true,
      promotion: "owner",
    },
    prompt: "Mine the FLEET MINING block with the metrics and failure clusters for one repeated pattern worth a new Skill, a new Scout, a Scout graduation or pruning, or an Archangel or workflow improvement.\nIf the history shows nothing repeated, pitch nothing.\n",
  },
};
