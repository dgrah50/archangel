import { describe, expect, it } from "bun:test";
import {
  KERNEL, Workflow, classifyChange, loosens, ownerMergesOnly, resolveWorkflow, trustHash,
  type HostWorkflowInput, type RepoWorkflowInput,
} from "../src/core/workflow.js";
import { hostInput, workflowFile } from "./helpers/workflow.js";

const baseFile = () => ({
  version: 1,
  gate: { testFileGlobs: ["test/**/*.test.ts"], testCmd: "npm test" },
  requiredChecks: ["Gate", "Test"],
  scouts: [{ name: "bug-hunt", skills: ["general/bug-hunt"] }],
});
const host = (o: Partial<HostWorkflowInput> = {}): HostWorkflowInput => ({
  shadowMode: false, maxAutoMergesPerDay: 3, maxAutoPromotionsPerDay: 1, scoutRunsPerDay: 2,
  maxConcurrentThreads: 2, scoutsEnabled: true, factoryRetry: true, isRevoked: () => false, fleetScouts: [], ...o,
});
const repo = (file: unknown, o: Partial<RepoWorkflowInput> = {}): RepoWorkflowInput => ({
  repo: "a/b", mainSha: "abc", fileRaw: file === null ? null : JSON.stringify(file),
  scoutPrompts: { "bug-hunt": "look hard" }, ...o,
});
const parse = (o: unknown) => Workflow.parse(o);
const withGate = (g: Record<string, unknown>) => ({ ...baseFile(), gate: { ...baseFile().gate, ...g } });

describe("kernel bounds", () => {
  it.each([
    ["maxNonTestLines above kernel", withGate({ maxNonTestLines: KERNEL.maxNonTestLines + 1 }), "gate.maxNonTestLines"],
    ["maxTotalLines above kernel", withGate({ maxTotalLines: KERNEL.maxTotalLines + 1 }), "gate.maxTotalLines"],
    ["maxFiles above kernel", withGate({ maxFiles: KERNEL.maxFiles + 1 }), "gate.maxFiles"],
    ["baseTestRuns below kernel", withGate({ baseTestRuns: KERNEL.minBaseTestRuns - 1 }), "gate.baseTestRuns"],
    ["headTestRuns below kernel", withGate({ headTestRuns: KERNEL.minHeadTestRuns - 1 }), "gate.headTestRuns"],
    ["total below non-test", withGate({ maxNonTestLines: 100, maxTotalLines: 50 }), "gate.maxTotalLines"],
    ["empty testFileGlobs", withGate({ testFileGlobs: [] }), "gate.testFileGlobs"],
    ["too many scouts", { ...baseFile(), scouts: Array.from({ length: KERNEL.maxScouts + 1 }, (_, i) => ({ name: `s${i}` })) }, "scouts"],
    ["duplicate scout", { ...baseFile(), scouts: [{ name: "x" }, { name: "x" }] }, "scouts.1.name"],
    ["requiredChecks without Gate", { ...baseFile(), requiredChecks: ["Test"] }, "requiredChecks"],
    ["requiredChecks Gate only (landing could never see main green)", { ...baseFile(), requiredChecks: ["Gate"] }, "requiredChecks"],
    ["requiredChecks missing", { ...baseFile(), requiredChecks: undefined }, "requiredChecks"],
    ["unknown fleet Scout in optOut (a typo must not keep one running)", { ...baseFile(), fleetScouts: { optOut: ["anti-slop-bug"] } }, "fleetScouts.optOut"],
    ["unknown key in fleetScouts", { ...baseFile(), fleetScouts: { optOut: [], enabled: true } }, "fleetScouts"],
    ["repo Scout reusing a fleet name", { ...baseFile(), scouts: [{ name: "anti-slop-bugs" }] }, "scouts.0.name"],
    ["unknown key", { ...baseFile(), labels: {} }, "labels"],
    ["bad skill ref", { ...baseFile(), scouts: [{ name: "x", skills: ["../x"] }] }, "scouts.0.skills"],
  ])("rejects %s", (_n: string, file: any, where: string) => {
    const r = resolveWorkflow(host(), repo(file));
    expect(r.status).toBe("invalid");
    expect((r as { error: string }).error).toContain(where);
  });

  it("applies kernel defaults, and invalid JSON, a missing file and a missing prompt fail closed", () => {
    const ok = resolveWorkflow(host(), repo(baseFile()));
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") {
      expect(ok.gate).toMatchObject({ maxNonTestLines: 150, maxTotalLines: 300, maxFiles: 5, baseTestRuns: 3, headTestRuns: 2 });
      expect(ok.requiredChecks).toEqual(["Gate", "Test"]);
    }
    expect(resolveWorkflow(host(), { ...repo(baseFile()), fileRaw: "{nope" }).status).toBe("invalid");
    expect(resolveWorkflow(host(), repo(null)).status).toBe("missing");
    expect(resolveWorkflow(host(), repo(baseFile(), { scoutPrompts: {} })).status).toBe("invalid");
  });
});

describe("fleet Scouts", () => {
  const fleetHost = host({ fleetScouts: ["anti-slop-bugs", "anti-slop-cleanup", "fleet-pr-miner"] });
  const names = (file: unknown) => {
    const r = resolveWorkflow(fleetHost, repo(file));
    if (r.status !== "ok") throw new Error(r.status === "invalid" ? r.error : r.status);
    return r;
  };

  it("run on a repo unless it opts out, and are never auto-promoted even when the host allows auto", () => {
    const on = names(baseFile());
    expect(on.scouts.filter((s) => s.fleet).map((s) => s.name)).toEqual(["anti-slop-bugs", "anti-slop-cleanup", "fleet-pr-miner"]);
    expect(on.scouts.filter((s) => s.fleet).map((s) => s.promotionEffective.value)).toEqual(["owner", "owner", "owner"]);
    const out = names({ ...baseFile(), fleetScouts: { optOut: ["anti-slop-cleanup"] } });
    expect(out.scouts.filter((s) => s.fleet).map((s) => s.name)).toEqual(["anti-slop-bugs", "fleet-pr-miner"]);
    expect(resolveWorkflow(host(), repo(baseFile()))).toMatchObject({ scouts: [{ name: "bug-hunt", fleet: false }] });
  });
});

describe("host clamp and provenance", () => {
  const auto = { ...baseFile(), landing: { bugfix: "autonomous" }, scouts: [{ name: "bug-hunt", promotion: "auto" }] };
  const okOf = (h: HostWorkflowInput, file: unknown = auto) => {
    const r = resolveWorkflow(h, repo(file));
    if (r.status !== "ok") throw new Error(r.error);
    return r;
  };

  it("shadowMode clamps autonomous landing to owner and records the declared value", () => {
    expect(okOf(host({ shadowMode: true })).landingBugfix).toEqual({ value: "owner", source: "host", declared: "autonomous" });
    expect(okOf(host()).landingBugfix).toEqual({ value: "autonomous", source: "repo" });
    expect(okOf(host({ shadowMode: true }), baseFile()).landingBugfix).toEqual({ value: "owner", source: "repo" });
  });

  it("features never land autonomously", () => {
    expect(ownerMergesOnly(okOf(host()), "feature")).toBe(true);
    expect(ownerMergesOnly(okOf(host()), "bugfix")).toBe(false);
    expect(ownerMergesOnly(okOf(host({ shadowMode: true })), "bugfix")).toBe(true);
  });

  it("auto promotion is clamped by a zero host cap and by revocation", () => {
    expect(okOf(host()).scouts[0]!.promotionEffective).toEqual({ value: "auto", source: "repo" });
    expect(okOf(host({ maxAutoPromotionsPerDay: 0 })).scouts[0]!.promotionEffective)
      .toEqual({ value: "owner", source: "host", declared: "auto" });
    const hash = okOf(host()).scouts[0]!.trustHash;
    const revoked = okOf(host({ isRevoked: (n, h) => n === "bug-hunt" && h === hash })).scouts[0]!;
    expect(revoked.revoked).toBe(true);
    expect(revoked.promotionEffective).toEqual({ value: "owner", source: "kernel", declared: "auto" });
  });

});

describe("classifyChange", () => {
  const prev = parse({
    ...baseFile(),
    gate: { ...baseFile().gate, maxFiles: 3, baseTestRuns: 4, protectedPaths: ["a/**"] },
    requiredChecks: ["Gate", "Test"],
    scouts: [{ name: "bug-hunt" }],
  });
  const edit = (f: (o: any) => void) => { const o = structuredClone(prev) as any; f(o); return parse(o); };
  const dir = (n: Workflow, field: string) => classifyChange(prev, n).find((c) => c.field === field)?.direction;

  it.each([
    ["maxFiles up", (o: any) => { o.gate.maxFiles = 5; }, "gate.maxFiles", "loosen"],
    ["maxFiles down", (o: any) => { o.gate.maxFiles = 2; }, "gate.maxFiles", "tighten"],
    ["baseTestRuns down", (o: any) => { o.gate.baseTestRuns = 3; }, "gate.baseTestRuns", "loosen"],
    ["testCmd edited", (o: any) => { o.gate.testCmd = "true"; }, "gate.testCmd", "changed"],
    ["protected path added", (o: any) => { o.gate.protectedPaths.push("b/**"); }, "gate.protectedPaths", "tighten"],
    ["protected path removed", (o: any) => { o.gate.protectedPaths = []; }, "gate.protectedPaths", "loosen"],
    ["required check added", (o: any) => { o.requiredChecks.push("Lint"); }, "requiredChecks", "tighten"],
    ["required check removed", (o: any) => { o.requiredChecks = ["Gate", "Other"]; }, "requiredChecks", "loosen"],
    ["landing autonomous", (o: any) => { o.landing = { bugfix: "autonomous" }; }, "landing.bugfix", "loosen"],
    ["scout to auto", (o: any) => { o.scouts[0].promotion = "auto"; }, "scouts.bug-hunt.promotion", "loosen"],
    ["scout metrics on", (o: any) => { o.scouts[0].includeMetrics = true; }, "scouts.bug-hunt.includeMetrics", "loosen"],
    ["scout added auto", (o: any) => { o.scouts.push({ name: "n", promotion: "auto" }); }, "scouts.n", "loosen"],
    ["scout removed", (o: any) => { o.scouts = []; }, "scouts.bug-hunt", "tighten"],
  ])("%s", (_n: string, f: (o: any) => void, field: string, want: string) => {
    expect(dir(edit(f), field)).toBe(want as ReturnType<typeof dir>);
  });

  it("reports nothing for an identical file and flags loosening in aggregate", () => {
    expect(classifyChange(prev, parse(structuredClone(prev)))).toEqual([]);
    expect(loosens(classifyChange(prev, edit((o) => { o.gate.maxFiles = 5; })))).toBe(true);
    expect(loosens(classifyChange(prev, edit((o) => { o.gate.maxFiles = 2; })))).toBe(false);
  });
});

describe("trustHash", () => {
  const spec = (f: unknown) => parse(f).scouts[0]!;
  const hashOf = (file: unknown, prompt = "p") => trustHash(spec(file), prompt);

  it("changes with the Scout's own entry or prompt", () => {
    const h = hashOf(baseFile());
    expect(hashOf(baseFile(), "p2")).not.toBe(h);
    for (const patch of [{ promotion: "auto" }, { maxProposals: 1 }, { schedule: "daily" }, { includeMetrics: true }, { skills: [] }]) {
      expect(hashOf({ ...baseFile(), scouts: [{ ...baseFile().scouts[0], ...patch }] })).not.toBe(h);
    }
  });
});

const resolve = (extra: Record<string, unknown> = {}, scouts: Array<{ name: string } & Record<string, unknown>> = [], prompts: Record<string, string> = {}, gate: Record<string, unknown> = {}) =>
  resolveWorkflow(hostInput(), {
    repo: "a/b",
    mainSha: "m",
    fileRaw: JSON.stringify(workflowFile(scouts, { ...extra, gate: { testFileGlobs: ["t/*.ts"], testCmd: "npm test", ...gate } })),
    scoutPrompts: prompts,
  });

describe("workflow schema holes", () => {
  it("rejects globs that can never match a git path: leading slash, ./, .., blank", () => {
    for (const bad of ["/src/config.ts", "./", ".", "../x", "a/../b", "  "]) {
      expect(resolve({}, [], {}, { protectedPaths: [bad] }).status, JSON.stringify(bad)).toBe("invalid");
      expect(resolve({}, [], {}, { testFileGlobs: [bad] }).status, JSON.stringify(bad)).toBe("invalid");
    }
    expect(resolve({}, [], {}, { protectedPaths: ["src/config.ts", "lock/**"] }).status).toBe("ok");

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

});
