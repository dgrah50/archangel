import { describe, expect, it } from "bun:test";
import { buildScoutPrompt, toScoutWorkflow } from "../src/core/scout.js";
import { okWorkflow } from "./helpers/workflow.js";
import { resolveSkills } from "../src/core/skills.js";

describe("bundled skills", () => {
  it("fails closed on unknown skills, empty folders and traversal", () => {
    expect(() => resolveSkills(["general/nope"])).toThrow(/Unknown skill/);
    expect(() => resolveSkills(["rust/*"])).toThrow(/no skills/);
    expect(() => resolveSkills(["../etc/passwd"])).toThrow(/Invalid skill/);
  });

  it("puts skill text in a Scout's prompt, ahead of the repo prompt body", () => {
    const wf = okWorkflow([{ name: "go-audit", schedule: "daily", skills: ["general/bug-hunt", "go/*"] }], { prompts: { "go-audit": "" } });
    const sw = toScoutWorkflow(wf.scouts[0]!);
    expect(sw.prompt).toBe("");
    const prompt = buildScoutPrompt(sw);
    expect(prompt).toContain("--- BUNDLED SKILL: general/bug-hunt ---");
    expect(prompt).toContain("--- BUNDLED SKILL: go/concurrency ---");
    expect(prompt).not.toContain("SCOUT WORKFLOW");
  });
});
