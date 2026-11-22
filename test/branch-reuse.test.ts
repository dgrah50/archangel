import { describe, expect, it } from "vitest";
import { createOrResetBranch, type OnboardRunner } from "../src/core/onboard.js";
import { PROPOSE_BRANCH, planWorkflowProposal, proposeWorkflow, readRepoFile } from "../src/core/workflow-propose.js";
import { workflowFile } from "./helpers/workflow.js";

const norm = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const current = workflowFile([], { gate: { testFileGlobs: ["t/*.ts"], testCmd: "npm test", maxFiles: 3 } });
const proposed = workflowFile([], { gate: { testFileGlobs: ["t/*.ts"], testCmd: "npm test", maxFiles: 5 } });

/** Owner `gh` that serves the current workflow; `branchExists` makes the proposal branch already exist; `readError` fails reads. */
function fake(o: { branchExists?: boolean; readError?: string }) {
  const calls: string[] = [];
  const runner: OnboardRunner = {
    async run(_cmd, args) {
      const line = args.join(" ");
      calls.push(line);
      if (line.startsWith("repo view")) return "main\n";
      if (line.includes("contents/.agents/archangel.json?ref=")) {
        if (o.readError) throw new Error(o.readError);
        return args.includes("--jq") ? "blobsha\n" : norm(current);
      }
      if (line.startsWith("pr list")) return "";
      if (/git\/ref\/heads\/chore\//.test(line)) {
        if (o.branchExists) return "oldsha\n";
        throw new Error("gh: Not Found (HTTP 404)");
      }
      if (line.includes("/git/ref/heads/")) return "tipsha\n";
      if (line.startsWith("pr create")) return "https://github.com/o/r/pull/9\n";
      return "";
    },
  };
  return { runner, calls };
}

describe("a leftover proposal branch does not wedge later proposals", () => {
  it("force-resets the existing branch to the default-branch tip instead of failing with 'Reference already exists'", async () => {
    const f = fake({ branchExists: true });
    const { url } = await proposeWorkflow(f.runner, "o/r", JSON.stringify(proposed), { log: () => {} });
    expect(url).toBe("https://github.com/o/r/pull/9");
    expect(f.calls.some((c) => c.includes("-X POST") && c.includes("git/refs"))).toBe(false);
    const patch = f.calls.find((c) => c.includes("-X PATCH"))!;
    expect(patch).toContain(`git/refs/heads/${PROPOSE_BRANCH}`);
    expect(patch).toContain("sha=tipsha");
    expect(patch).toContain("force=true");
  });

  it("still creates the branch when it does not exist, and rethrows real errors", async () => {
    const created = fake({});
    await createOrResetBranch(created.runner, "o/r", "chore/x", "abc");
    expect(created.calls.some((c) => c.includes("-X POST") && c.includes("ref=refs/heads/chore/x"))).toBe(true);
    const broken: OnboardRunner = { async run() { throw new Error("HTTP 502 Bad Gateway"); } };
    await expect(createOrResetBranch(broken, "o/r", "chore/x", "abc")).rejects.toThrow(/502/);
  });
});

describe("reading the current workflow file fails closed", () => {
  it("returns null only for a 404; a rate limit or 5xx throws instead of looking like 'no file'", async () => {
    const notFound: OnboardRunner = { async run() { throw new Error("gh: Not Found (HTTP 404)"); } };
    expect(await readRepoFile(notFound, "o/r", "main", ".agents/archangel.json")).toBeNull();
    for (const msg of ["HTTP 502 Bad Gateway", "API rate limit exceeded (HTTP 403)", "timeout"]) {
      const failing: OnboardRunner = { async run() { throw new Error(msg); } };
      await expect(readRepoFile(failing, "o/r", "main", ".agents/archangel.json")).rejects.toThrow(msg);
    }
  });

  it("a transient read failure aborts a proposal instead of reporting 'No loosening detected'", async () => {
    const f = fake({ readError: "HTTP 502 Bad Gateway" });
    await expect(planWorkflowProposal(f.runner, "o/r", JSON.stringify(proposed))).rejects.toThrow(/502/);
    await expect(proposeWorkflow(f.runner, "o/r", JSON.stringify(proposed), { dryRun: true, log: () => {} })).rejects.toThrow(/502/);
  });

  it("reads the file at the tip sha it resolved once, not at a moving branch name", async () => {
    const f = fake({});
    await planWorkflowProposal(f.runner, "o/r", JSON.stringify(proposed));
    const reads = f.calls.filter((c) => c.includes("contents/.agents/archangel.json?ref="));
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r).toContain("?ref=tipsha");
  });
});
