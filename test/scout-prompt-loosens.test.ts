import { describe, expect, it } from "vitest";
import type { OnboardRunner } from "../src/core/onboard.js";
import { planWorkflowProposal } from "../src/core/workflow-propose.js";
import { workflowFile } from "./helpers/workflow.js";

const norm = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

function fake(workflow: unknown, prompts: Record<string, string>): OnboardRunner {
  return {
    async run(_cmd, args) {
      const line = args.join(" ");
      if (line.startsWith("repo view")) return "main\n";
      if (line.includes("/git/ref/heads/")) return "tipsha\n";
      if (line.includes("contents/.agents/archangel.json?ref=")) return args.includes("--jq") ? "wblob\n" : norm(workflow);
      const m = /contents\/\.agents\/scouts\/([\w-]+)\.md\?ref=/.exec(line);
      if (m) {
        const p = prompts[m[1]!];
        if (p === undefined) throw new Error("HTTP 404");
        return args.includes("--jq") ? "sblob\n" : p;
      }
      if (line.startsWith("pr list")) return "";
      return "";
    },
  };
}

const wf = (promotion: "auto" | "owner") =>
  workflowFile([{ name: "hunt", schedule: "daily", promotion }], { gate: { testFileGlobs: ["t/*.ts"], testCmd: "npm test" } });

describe("Scout prompt edits are visible in the proposal's classification", () => {
  it("flags a prompt edit of an auto-promoting Scout as a loosening (it would re-arm a revoked Scout)", async () => {
    const plan = await planWorkflowProposal(fake(wf("auto"), { hunt: "Find bugs.\n" }), "o/r", JSON.stringify(wf("auto")), {
      scoutPrompts: { hunt: "Find bugs. Also anything else you like." },
    });
    expect(plan.changes).toContainEqual({ field: "scouts.hunt.prompt", direction: "loosen" });
    expect(plan.loosens).toBe(true);
    expect(plan.body).not.toContain("No workflow field changes");
  });

  it("lists a prompt edit of an owner-promoted Scout as a plain change, not a loosening", async () => {
    const plan = await planWorkflowProposal(fake(wf("owner"), { hunt: "Find bugs.\n" }), "o/r", JSON.stringify(wf("owner")), {
      scoutPrompts: { hunt: "Find different bugs." },
    });
    expect(plan.changes).toEqual([{ field: "scouts.hunt.prompt", direction: "changed" }]);
    expect(plan.loosens).toBe(false);
  });

  it("does not report a prompt change when only surrounding whitespace differs", async () => {
    await expect(
      planWorkflowProposal(fake(wf("auto"), { hunt: "Find bugs.\n" }), "o/r", JSON.stringify(wf("auto")), { scoutPrompts: { hunt: "  Find bugs.  " } }),
    ).rejects.toThrow(/nothing to propose|identical/);
  });
});
