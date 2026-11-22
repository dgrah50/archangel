import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OnboardRunner } from "../src/core/onboard.js";
import { LOOSENS_LABEL, PROPOSE_BRANCH, proposeWorkflow } from "../src/core/workflow-propose.js";
import { workflowFile } from "./helpers/workflow.js";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const norm = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

/** Scripted owner `gh`: serves a current workflow file and records every call. */
function fake(opts: { current?: string | null; openPr?: string; labels?: string[]; prompts?: Record<string, string>; changeOnReread?: boolean }) {
  const calls: string[] = [];
  let reads = 0;
  const runner: OnboardRunner = {
    async run(_cmd, args) {
      const line = args.join(" ");
      calls.push(line);
      if (line.startsWith("repo view")) return "main\n";
      if (line.includes("contents/.agents/archangel.json?ref=")) {
        if (opts.current == null) throw new Error("404");
        if (args.includes("--jq")) return "blobsha\n";
        reads++;
        return opts.changeOnReread && reads > 1 ? opts.current + " " : opts.current;
      }
      const sm = /contents\/\.agents\/scouts\/([\w-]+)\.md\?ref=/.exec(line);
      if (sm) {
        const p = opts.prompts?.[sm[1]!];
        if (p === undefined) throw new Error("404");
        return args.includes("--jq") ? "scoutblob\n" : p;
      }
      if (line.startsWith("pr list")) return opts.openPr ?? "";
      if (/git\/ref\/heads\/chore\//.test(line)) throw new Error("HTTP 404");
      if (line.includes("/git/ref/heads/")) return "tipsha\n";
      if (line.startsWith("label list")) return (opts.labels ?? []).join("\n");
      if (line.startsWith("pr create")) return "https://github.com/o/r/pull/9\n";
      return "";
    },
  };
  return { runner, calls, mutating: () => calls.filter((c) => /label create|-X POST|-X PUT|pr create/.test(c)) };
}

const current = workflowFile([], { gate: { testFileGlobs: ["test/**/*.test.ts"], testCmd: "npm test", maxFiles: 3 } });
const quiet = { log: () => {} };

describe("proposeWorkflow", () => {
  it("opens one PR on the proposal branch, never merging, with loosened fields first in bold and the label", async () => {
    const f = fake({ current: norm(current) });
    const proposed = workflowFile([], {
      gate: { testFileGlobs: ["test/**/*.test.ts"], testCmd: "npm test", maxFiles: 5, protectedPaths: ["lock.json"] },
      landing: { bugfix: "autonomous" },
    });
    const { plan, url } = await proposeWorkflow(f.runner, "o/r", JSON.stringify(proposed), { ...quiet, baseFileSha256: sha(norm(current)) });
    expect(url).toBe("https://github.com/o/r/pull/9");
    expect(plan.loosens).toBe(true);
    const body = f.calls.find((c) => c.startsWith("pr create"))!;
    expect(body).toContain(`--head ${PROPOSE_BRANCH}`);
    expect(body).toContain(`--label ${LOOSENS_LABEL}`);
    expect(f.calls.some((c) => /pr merge/.test(c))).toBe(false);
    expect(f.calls.some((c) => c.startsWith(`label create ${LOOSENS_LABEL}`))).toBe(true);
    // loosened rows come before tightened ones
    expect(plan.body.indexOf("**gate.maxFiles**")).toBeGreaterThan(-1);
    expect(plan.body.indexOf("**landing.bugfix**")).toBeLessThan(plan.body.indexOf("gate.protectedPaths"));
    expect(plan.body).toContain("| gate.protectedPaths | tightens |");
    // updating an existing file passes its blob sha
    expect(f.calls.find((c) => c.includes("-X PUT"))).toContain("sha=blobsha");
  });

  it("rejects an invalid file (schema or kernel bound) before any gh write", async () => {
    const f = fake({ current: norm(current) });
    const tooLoose = workflowFile([], { gate: { testFileGlobs: ["t"], testCmd: "x", maxFiles: 50 } });
    await expect(proposeWorkflow(f.runner, "o/r", JSON.stringify(tooLoose), quiet)).rejects.toThrow(/gate\.maxFiles/);
    await expect(proposeWorkflow(f.runner, "o/r", JSON.stringify(workflowFile([], { requiredChecks: ["Gate"] })), quiet)).rejects.toThrow(/requiredChecks/);
    await expect(proposeWorkflow(f.runner, "o/r", "{nope", quiet)).rejects.toThrow(/not valid JSON/);
    expect(f.mutating()).toEqual([]);
  });

  it("refuses a stale base, an already-open proposal, an identical file and a missing Scout prompt", async () => {
    const f = fake({ current: norm(current) });
    const proposed = JSON.stringify(workflowFile([], { gate: { testFileGlobs: ["test/**/*.test.ts"], testCmd: "npm test", maxFiles: 2 } }));
    await expect(proposeWorkflow(f.runner, "o/r", proposed, { ...quiet, baseFileSha256: "0".repeat(64) })).rejects.toThrow(/Stale draft/);
    const open = fake({ current: norm(current), openPr: "https://github.com/o/r/pull/3" });
    await expect(proposeWorkflow(open.runner, "o/r", proposed, quiet)).rejects.toThrow(/already open/);
    await expect(proposeWorkflow(fake({ current: norm(current) }).runner, "o/r", JSON.stringify(current), quiet)).rejects.toThrow(/identical/);
    const withScout = JSON.stringify(workflowFile([{ name: "s1" }], { gate: current.gate }));
    await expect(proposeWorkflow(f.runner, "o/r", withScout, quiet)).rejects.toThrow(/no prompt file/);
    for (const x of [f, open]) expect(x.mutating()).toEqual([]);
  });

  it("labels a proposal policy:loosens when the current file is invalid and the proposal grants autonomy (nothing proves it does not loosen)", async () => {
    const stale = JSON.stringify({ maxFiles: 3 }); // an old-format file: does not parse as a workflow
    const loose = fake({ current: stale });
    const a = await proposeWorkflow(loose.runner, "o/r", JSON.stringify(workflowFile([], { landing: { bugfix: "autonomous" } })), quiet);
    expect(a.plan.classified).toBe(false);
    expect(a.plan.loosens).toBe(true);
    expect(loose.calls.find((c) => c.startsWith("pr create"))).toContain(`--label ${LOOSENS_LABEL}`);
    const promoting = fake({ current: stale });
    const b = await proposeWorkflow(promoting.runner, "o/r", JSON.stringify(workflowFile([{ name: "s", promotion: "auto" }])), { ...quiet, scoutPrompts: { s: "p" } });
    expect(b.plan.loosens).toBe(true);
    const owner = fake({ current: stale });
    const c = await proposeWorkflow(owner.runner, "o/r", JSON.stringify(workflowFile([])), quiet);
    expect(c.plan.loosens).toBe(false);
  });
});
