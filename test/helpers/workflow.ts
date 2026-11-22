import {
  ScoutSpec,
  resolveWorkflow,
  trustHash,
  type HostWorkflowInput,
  type OkWorkflow,
} from "../../src/core/workflow.js";

type ScoutInput = { name: string } & Record<string, unknown>;

export const SCOUT_PROMPT = "Find real bugs in app.ts.";

/** A valid version 1 workflow file as a plain object. */
export function workflowFile(scouts: ScoutInput[] = [], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    gate: { testFileGlobs: ["test/**/*.test.ts"], testCmd: "npm test" },
    requiredChecks: ["Gate", "Test"],
    scouts,
    ...extra,
  };
}

export function workflowJson(scouts: ScoutInput[] = [], extra: Record<string, unknown> = {}): string {
  return JSON.stringify(workflowFile(scouts, extra), null, 2) + "\n";
}

export function hostInput(o: Partial<HostWorkflowInput> = {}): HostWorkflowInput {
  return {
    shadowMode: false,
    maxAutoMergesPerDay: 3,
    maxAutoPromotionsPerDay: 1,
    scoutRunsPerDay: 2,
    scoutsEnabled: true,
    maxConcurrentThreads: 2,
    factoryRetry: true,
    fleetScouts: [],
    isRevoked: () => false,
    ...o,
  };
}

/** The resolved workflow for `scouts` (prompt defaults to SCOUT_PROMPT), as the runner receives it. */
export function okWorkflow(
  scouts: ScoutInput[] = [],
  opts: { prompts?: Record<string, string>; host?: Partial<HostWorkflowInput>; extra?: Record<string, unknown> } = {},
): OkWorkflow {
  const prompts = opts.prompts ?? Object.fromEntries(scouts.map((s) => [s.name, SCOUT_PROMPT]));
  const r = resolveWorkflow(hostInput(opts.host), {
    repo: "acme/app",
    mainSha: "main",
    fileRaw: workflowJson(scouts, opts.extra),
    scoutPrompts: prompts,
  });
  if (r.status !== "ok") throw new Error(`test workflow not ok: ${r.status === "missing" ? "missing" : r.error}`);
  return r;
}

export function hashOfScout(spec: ScoutInput, prompt = SCOUT_PROMPT): string {
  return trustHash(ScoutSpec.parse(spec), prompt);
}

/** A Go repo's workflow for reconciler e2e tests: bugfixes may land autonomously (the host shadowMode arm decides). */
export function goWorkflowJson(requiredChecks: string[] = ["Gate", "Test"]): string {
  return workflowJson([], {
    requiredChecks,
    landing: { bugfix: "autonomous" },
    gate: { testFileGlobs: ["**/*_test.go"], testCmd: "go test ./..." },
  });
}
