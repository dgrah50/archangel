import { describe, expect, it } from "bun:test";
import { Workflow } from "../src/core/workflow.js";
import { buildPlan, onboard, type OnboardRunner } from "../src/core/onboard.js";

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

});

describe("onboard", () => {
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

});
