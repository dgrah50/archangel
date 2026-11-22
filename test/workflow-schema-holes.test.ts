import { describe, expect, it } from "vitest";
import { resolveWorkflow, trustHash, ScoutSpec, classifyChange, Workflow } from "../src/core/workflow.js";
import { isProtectedPath } from "../src/gate/gate.js";
import { hostInput, workflowFile } from "./helpers/workflow.js";

const resolve = (extra: Record<string, unknown> = {}, scouts: Array<{ name: string } & Record<string, unknown>> = [], prompts: Record<string, string> = {}, gate: Record<string, unknown> = {}) =>
  resolveWorkflow(hostInput(), {
    repo: "a/b",
    mainSha: "m",
    fileRaw: JSON.stringify(workflowFile(scouts, { ...extra, gate: { testFileGlobs: ["t/*.ts"], testCmd: "npm test", ...gate } })),
    scoutPrompts: prompts,
  });

describe("workflow schema holes", () => {
  it("rejects whitespace-only commands and required checks", () => {
    for (const gate of [{ testCmd: "   " }, { baseTestCmd: "\t" }, { testBuildCmd: "  \n" }]) {
      expect(resolve({}, [], {}, gate).status, JSON.stringify(gate)).toBe("invalid");
    }
    expect(resolve({ requiredChecks: ["Gate", "   "] }).status).toBe("invalid");
  });

  it("rejects globs that can never match a git path: leading slash, ./, .., blank", () => {
    for (const bad of ["/src/config.ts", "./", ".", "../x", "a/../b", "  "]) {
      expect(resolve({}, [], {}, { protectedPaths: [bad] }).status, JSON.stringify(bad)).toBe("invalid");
      expect(resolve({}, [], {}, { testFileGlobs: [bad] }).status, JSON.stringify(bad)).toBe("invalid");
    }
    expect(resolve({}, [], {}, { protectedPaths: ["src/config.ts", "lock/**"] }).status).toBe("ok");
    // The old shape silently left the file unprotected:
    expect(isProtectedPath("src/config.ts", ["/src/config.ts"])).toBe(false);
  });

  it("rejects a Scout with an empty prompt and no skills, but accepts either one", () => {
    const scout = { name: "s", schedule: "manual" };
    expect(resolve({}, [scout], { s: "   " }).status).toBe("invalid");
    expect(resolve({}, [scout], { s: "Find bugs." }).status).toBe("ok");
    expect(resolve({}, [{ ...scout, skills: ["general/bug-hunt"] }], { s: "" }).status).toBe("ok");
  });

  it("does not treat Object.prototype members as a Scout's prompt file", () => {
    const r = resolve({}, [{ name: "constructor", schedule: "manual", skills: ["general/bug-hunt"] }], {});
    expect(r.status).toBe("invalid");
    expect(r.status === "invalid" && r.error).toContain("has no .agents/scouts/constructor.md");
  });

  it("hashes the trimmed prompt, so a trailing newline never changes a Scout's trust hash", () => {
    const ok = (p: string) => {
      const r = resolve({}, [{ name: "s", schedule: "manual" }], { s: p });
      return r.status === "ok" ? r.scouts[0]!.trustHash : r.status;
    };
    expect(ok("Find bugs.\n")).toBe(ok("Find bugs."));
    expect(ok("Find bugs.")).toBe(trustHash(ScoutSpec.parse({ name: "s" }), "Find bugs."));
  });

  it("classifies removing testBuildCmd as a loosening and adding it as a tightening", () => {
    const base = (extra: Record<string, unknown>) =>
      Workflow.parse(workflowFile([], { gate: { testFileGlobs: ["t/*.ts"], testCmd: "npm test", ...extra } }));
    const withBuild = base({ testBuildCmd: "npm run build" });
    const without = base({});
    expect(classifyChange(withBuild, without)).toContainEqual({ field: "gate.testBuildCmd", direction: "loosen" });
    expect(classifyChange(without, withBuild)).toContainEqual({ field: "gate.testBuildCmd", direction: "tighten" });
    expect(classifyChange(withBuild, base({ testBuildCmd: "make" }))).toContainEqual({ field: "gate.testBuildCmd", direction: "changed" });
  });
});
