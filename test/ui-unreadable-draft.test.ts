import { describe, expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger/store.js";
import { hostInput, workflowFile } from "./helpers/workflow.js";
import { resolveWorkflow } from "../src/core/workflow.js";

vi.mock("../src/core/ui-propose.js", () => ({
  draftFromEffective: () => {
    throw new Error("draft shape changed");
  },
}));

describe("a workflow whose editable draft cannot be built", () => {
  it("is reported as unreadable with the reason, not as ok with the editor silently hidden", async () => {
    const { buildWorkflowsState } = await import("../src/core/ui-state.js");
    const r = resolveWorkflow(hostInput(), { repo: "a/b", mainSha: "m".repeat(40), fileRaw: JSON.stringify(workflowFile([{ name: "bug-hunt", promotion: "owner" }])), scoutPrompts: { "bug-hunt": "p" } });
    const l = new Ledger(":memory:", { repo: "a/b" });
    l.setSystemState("workflow:a/b", JSON.stringify(r));
    const repo = buildWorkflowsState(l).repos[0]!;
    expect(repo.status).toBe("unreadable");
    expect(repo.error).toContain("draft shape changed");
    expect(repo.draft).toBeUndefined();
  });
});
