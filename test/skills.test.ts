import { describe, expect, it } from "vitest";
import { buildScoutPrompt, parseScoutMarkdown } from "../src/core/scout.js";
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

  it("lets a Scout be defined by skills alone and puts skill text in its prompt", () => {
    const wf = parseScoutMarkdown("---\nname: go-audit\nschedule: daily\nskills: [general/bug-hunt, go/*]\n---\n", "s.md");
    expect(wf.prompt).toBe("");
    const prompt = buildScoutPrompt(wf);
    expect(prompt).toContain("--- BUNDLED SKILL: general/bug-hunt ---");
    expect(prompt).toContain("--- BUNDLED SKILL: go/concurrency ---");
    expect(prompt).not.toContain("SCOUT WORKFLOW");
    expect(() => parseScoutMarkdown("---\nname: empty\n---\n", "e.md")).toThrow(/prompt body or at least one skill/);
    expect(() => parseScoutMarkdown("---\nname: bad\nskills: [general/missing]\n---\nBody\n", "b.md")).toThrow(/Unknown skill/);
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
