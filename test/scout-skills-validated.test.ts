import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import type { OnboardRunner } from "../src/core/onboard.js";
import { planWorkflowProposal } from "../src/core/workflow-propose.js";
import { loadWorkflow } from "../src/core/workflow-load.js";
import { workflowJson } from "./helpers/workflow.js";

const cfg = ConfigSchema.parse({
  githubOwner: "a", githubRepo: "b", ownerUserId: 1, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "x",
});
const ledger = { isScoutAutoPromoteRevoked: () => false };
const reader = (scouts: Array<Record<string, unknown> & { name: string }>) => ({
  async readFileAtRef(_ref: string, p: string) {
    if (p === ".agents/archangel.json") return workflowJson(scouts);
    return p.startsWith(".agents/scouts/") ? "Find bugs." : null;
  },
});

describe("Scout skills are validated where the workflow is loaded", () => {
  it("a typo'd skill makes the workflow invalid (the repo halts) instead of crashing every Scout later", async () => {
    const bad = await loadWorkflow(reader([{ name: "good", skills: ["general/bug-hunt"] }, { name: "typo", skills: ["general/bug-hunts"] }]), cfg, ledger, "m");
    expect(bad.status).toBe("invalid");
    expect(bad.status === "invalid" && bad.error).toMatch(/scout 'typo'.*Unknown skill 'general\/bug-hunts'/);
    const ok = await loadWorkflow(reader([{ name: "good", skills: ["general/bug-hunt", "go/*"] }]), cfg, ledger, "m");
    expect(ok.status).toBe("ok");
  });

  it("`workflow propose` refuses a draft that references an unknown skill, before any gh call that writes", async () => {
    const calls: string[] = [];
    const runner: OnboardRunner = { async run(_c, args) { calls.push(args.join(" ")); return ""; } };
    const file = JSON.parse(workflowJson([{ name: "typo", skills: ["general/nope"] }]));
    await expect(planWorkflowProposal(runner, "o/r", JSON.stringify(file), { scoutPrompts: { typo: "x" } })).rejects.toThrow(/Scout 'typo': Unknown skill 'general\/nope'/);
    expect(calls).toEqual([]);
  });
});
