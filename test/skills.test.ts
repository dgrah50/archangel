import { describe, expect, it } from "vitest";
import { buildScoutPrompt, toScoutWorkflow } from "../src/core/scout.js";
import { okWorkflow } from "./helpers/workflow.js";
import { resolveSkills } from "../src/core/skills.js";

describe("bundled skills", () => {
  it("expands folder wildcards in order without duplicates", () => {
    const refs = resolveSkills(["general/bug-hunt", "go/*", "general/bug-hunt"]).map((s) => s.ref);
    expect(refs[0]).toBe("general/bug-hunt");
    expect(refs.filter((r) => r === "general/bug-hunt")).toHaveLength(1);
    expect(refs.slice(1).every((r) => r.startsWith("go/"))).toBe(true);
  });

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

describe("owner-opinion skills", () => {
  it("resolves and demands failing, measured evidence", () => {
    const [sm, rw] = resolveSkills(["general/implicit-state-machines", "general/repeated-work"]);
    expect(sm!.content).toContain("fails today");
    expect(rw!.content).toMatch(/measurement or concrete count/);
    expect(rw!.content).toContain("fails on `main` today");
  });
});
