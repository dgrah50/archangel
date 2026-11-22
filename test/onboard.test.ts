import { describe, expect, it } from "vitest";
import { Workflow } from "../src/core/workflow.js";
import { buildPlan, detectStack, onboard, type OnboardRunner } from "../src/core/onboard.js";

const SHA = "a".repeat(40);

/** Scripted runner: answers by matching the joined command line; records everything it was asked. */
function fake(opts: { tree: string[]; labels?: string[]; dirty?: boolean; onMain?: boolean; pkg?: object; openPr?: string }) {
  const calls: string[] = [];
  const runner: OnboardRunner = {
    async run(cmd, args) {
      const line = `${cmd} ${args.join(" ")}`;
      calls.push(line);
      if (line === "git status --porcelain") return opts.dirty ? " M x\n" : "";
      if (line.startsWith("git fetch")) return "";
      if (line === "git rev-parse HEAD") return `${SHA}\n`;
      if (line.startsWith("git merge-base")) {
        if (opts.onMain === false) throw Object.assign(new Error("not ancestor"), { code: 1 });
        return "";
      }
      if (line.startsWith("gh repo view")) return "main\n";
      if (line.includes("/git/trees/")) return opts.tree.join("\n");
      if (line.startsWith("gh label list")) return (opts.labels ?? []).join("\n");
      if (line.includes("contents/package.json")) return JSON.stringify(opts.pkg ?? {});
      if (line.startsWith("gh pr list")) return opts.openPr ?? "";
      if (/git\/ref\/heads\/chore\//.test(line)) throw new Error("HTTP 404");
      if (line.includes("/git/ref/heads/")) return "basesha\n";
      if (line.startsWith("gh pr create")) return "https://github.com/o/r/pull/1\n";
      return "";
    },
  };
  return { runner, calls, mutating: () => calls.filter((c) => /label create|-X POST|-X PUT|pr create/.test(c)) };
}

describe("detectStack", () => {
  it("maps go.mod to go and package.json to node, else null", () => {
    expect(detectStack(["go.mod", "main.go"])).toBe("go");
    expect(detectStack(["package.json"])).toBe("node");
    expect(detectStack(["Cargo.toml"])).toBeNull();
  });
});

describe("buildPlan", () => {
  it("plans all three files for a go repo and pins the workflow to HEAD", async () => {
    const { runner } = fake({ tree: ["go.mod", "a_test.go"], labels: ["needs-you"] });
    const plan = await buildPlan(runner, "o/r");
    expect(plan.stack).toBe("go");
    expect(plan.files.map((f) => f.path)).toEqual([".github/workflows/archangel-gate.yml", ".agents/archangel.json", ".agents/scouts/bug-hunt.md"]);
    expect(plan.files[0]!.content).toContain(`ARCHANGEL_GATE_SHA: ${SHA}`);
    expect(plan.files[1]!.content).toContain("go test");
    const wf = JSON.parse(plan.files[1]!.content);
    expect(wf).toMatchObject({ version: 1, requiredChecks: ["Gate", "Test"] });
    expect(wf.scouts).toEqual([{ name: "bug-hunt", schedule: "daily", maxProposals: 2, skills: ["general/bug-hunt", "general/input-validation", "go/*"] }]);
    expect(Workflow.safeParse(wf).success).toBe(true);
    expect(plan.files[2]!.content.startsWith("---")).toBe(false); // body-only prompt, no frontmatter
    expect(plan.labelsToCreate).not.toContain("needs-you");
    expect(plan.labelsToCreate).toContain("ready-for-agent");
  });

  it("adds only the missing files, and no Scout prompt without a new workflow file to declare it", async () => {
    const { runner } = fake({ tree: ["go.mod", ".agents/archangel.json", ".github/workflows/archangel-gate.yml"] });
    const plan = await buildPlan(runner, "o/r");
    expect(plan.files).toEqual([]);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.notes.join(" ")).toContain("add a Scout entry");
  });

  it("derives the node starter from existing tests and package.json scripts.test", async () => {
    const { runner } = fake({ tree: ["package.json", "package-lock.json", "src/a.test.ts"], pkg: { scripts: { test: "vitest run" } } });
    const plan = await buildPlan(runner, "o/r");
    const policy = JSON.parse(plan.files.find((f) => f.path === ".agents/archangel.json")!.content);
    expect(Workflow.safeParse(policy).success).toBe(true);
    expect(policy.gate.testFileGlobs).toEqual(["**/*.test.ts"]);
    expect(policy.gate.testCmd).toBe("npm test");
    expect(policy.gate.protectedPaths).toEqual(["package.json", "package-lock.json"]);
    expect(policy.scouts[0].skills).toContain("typescript/*");
  });

  it("does not guess a node policy without scripts.test, and still plans the rest", async () => {
    const { runner } = fake({ tree: ["package.json", "a.test.ts"], pkg: {} });
    const plan = await buildPlan(runner, "o/r");
    expect(plan.files.map((f) => f.path)).not.toContain(".agents/archangel.json");
    expect(plan.notes.join(" ")).toContain("scripts.test");
    expect(plan.files.map((f) => f.path)).toContain(".github/workflows/archangel-gate.yml");
  });

  it("handles an unknown stack by noting what to write by hand", async () => {
    const { runner } = fake({ tree: ["Cargo.toml"] });
    const plan = await buildPlan(runner, "o/r");
    expect(plan.stack).toBeNull();
    expect(plan.notes.join(" ")).toContain("by hand");
    expect(plan.files.map((f) => f.path)).toEqual([".github/workflows/archangel-gate.yml"]);
  });

  it("a git failure other than exit 1 is an error, not 'not on origin/main'", async () => {
    const base = fake({ tree: [] }).runner;
    const broken: OnboardRunner = {
      async run(cmd, args, o) {
        if (args[0] === "merge-base") throw Object.assign(new Error("fatal: not a git repository"), { code: 128 });
        return base.run(cmd, args, o);
      },
    };
    await expect(buildPlan(broken, "o/r")).rejects.toThrow(/not a git repository/);
  });

  it("refuses a dirty Archangel checkout or a HEAD that is not on origin/main", async () => {
    await expect(buildPlan(fake({ tree: [], dirty: true }).runner, "o/r")).rejects.toThrow(/uncommitted/);
    await expect(buildPlan(fake({ tree: [], onMain: false }).runner, "o/r")).rejects.toThrow(/not on origin\/main/);
  });
});

describe("onboard", () => {
  it("dry-run changes nothing", async () => {
    const f = fake({ tree: ["go.mod"] });
    const out: string[] = [];
    await onboard(f.runner, "o/r", { dryRun: true, log: (s) => out.push(s) });
    expect(f.mutating()).toEqual([]);
    expect(out.join("\n")).toContain("Dry run: nothing changed.");
    expect(out.join("\n")).toContain("- repo: o/r");
  });

  it("creates labels, a branch, files and one PR, never merging", async () => {
    const f = fake({ tree: ["go.mod"] });
    await onboard(f.runner, "o/r", { log: () => {} });
    const m = f.mutating();
    expect(m.filter((c) => c.includes("label create"))).toHaveLength(8);
    expect(m.filter((c) => c.includes("-X PUT"))).toHaveLength(3);
    expect(m.filter((c) => c.includes("pr create"))).toHaveLength(1);
    expect(f.calls.some((c) => c.startsWith("gh pr merge"))).toBe(false);
  });

  it("is idempotent when the onboarding PR is already open", async () => {
    const f = fake({ tree: ["go.mod"], labels: ["ready-for-agent", "factory:paused", "factory:stop", "needs-you", "factory:disagree", "agent-proposed", "agent-pitch", "class:feature"], openPr: "https://github.com/o/r/pull/9" });
    await onboard(f.runner, "o/r", { log: () => {} });
    expect(f.mutating()).toEqual([]);
  });

  it("rejects a malformed repo argument", async () => {
    await expect(onboard(fake({ tree: [] }).runner, "nope", { log: () => {} })).rejects.toThrow(/owner\/name/);
  });
});
