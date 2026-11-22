import { describe, expect, it } from "vitest";
import { type OnboardRunner } from "../src/core/onboard.js";
import { PROPOSE_BRANCH, planWorkflowProposal, proposeWorkflow, readRepoFile } from "../src/core/workflow-propose.js";
import { workflowFile } from "./helpers/workflow.js";

const norm = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const current = workflowFile([], { gate: { testFileGlobs: ["t/*.ts"], testCmd: "npm test", maxFiles: 3 } });
const proposed = workflowFile([], { gate: { testFileGlobs: ["t/*.ts"], testCmd: "npm test", maxFiles: 5 } });

/** Owner `gh` that serves the current workflow; `branchExists` makes the proposal branch already exist; `readError` fails reads. */
function fake(o: { branchExists?: boolean; readError?: string }) {
  const calls: string[] = [];
  const runner: OnboardRunner = {
    async run(_cmd, args) {
      const line = args.join(" ");
      calls.push(line);
      if (line.startsWith("repo view")) return "main\n";
      if (line.includes("contents/.agents/archangel.json?ref=")) {
        if (o.readError) throw new Error(o.readError);
        return args.includes("--jq") ? "blobsha\n" : norm(current);
      }
      if (line.startsWith("pr list")) return "";
      if (/git\/ref\/heads\/chore\//.test(line)) {
        if (o.branchExists) return "oldsha\n";
        throw new Error("gh: Not Found (HTTP 404)");
      }
      if (line.includes("/git/ref/heads/")) return "tipsha\n";
      if (line.startsWith("pr create")) return "https://github.com/o/r/pull/9\n";
      return "";
    },
  };
  return { runner, calls };
}


describe("reading the current workflow file fails closed", () => {

  it("a transient read failure aborts a proposal instead of reporting 'No loosening detected'", async () => {
    const f = fake({ readError: "HTTP 502 Bad Gateway" });
    await expect(planWorkflowProposal(f.runner, "o/r", JSON.stringify(proposed))).rejects.toThrow(/502/);
    await expect(proposeWorkflow(f.runner, "o/r", JSON.stringify(proposed), { dryRun: true, log: () => {} })).rejects.toThrow(/502/);
  });

});
