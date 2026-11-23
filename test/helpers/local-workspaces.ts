import { LocalProvider } from "../../src/compute/local.js";
import type { ImplementInput } from "../../src/agents/implementer.js";

/** The workspaces of an implementer run whose clone already exists at `dir`. */
export function localAt(dir: string): ImplementInput["workspaces"] {
  const compute = new LocalProvider({ createThrowawayClone: async () => dir, removeClone: () => undefined });
  return { local: { compute, workspace: async () => ({ id: dir, path: dir }) } };
}
