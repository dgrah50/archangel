import type { ScoutCliInvoker } from "../../src/core/scout.js";

/** The triage/recommendation CLI for tests that do not exercise it: it fails at once, as a missing CLI does, instead of spawning a real one. */
export const noCli: ScoutCliInvoker = async () => {
  throw new Error("no triage CLI in tests");
};
