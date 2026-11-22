import { describe, expect, it } from "vitest";
import { FACTORY_AUTO_OFF_UNMERGED, FACTORY_AUTO_OFF_WINDOW, classifyFactoryOutcome, shouldAutoOff, type FactoryOutcome } from "../src/core/factory-retry.js";
import { TRIAGE_ELIGIBLE_CODES, TriageOutputSchema, buildTriagePrompt, extractPaths, pickTriageProvider, validateTriage, type TriageChecks } from "../src/core/triage.js";

const good = {
  decision: "guidance",
  cause: "scope_too_broad",
  guidance: "Narrow the change to the case in the issue.",
  steps: ["In `src/parse.ts` delete the extra array branch", "Keep the UTF-8 guard out"],
  keepUnchanged: ["`src/lexer.ts` behaviour"],
  escalateReason: "",
};
const checks = (over: Partial<TriageChecks> = {}): TriageChecks => ({
  isProtected: (p) => p.startsWith("protected/"),
  existsAtHead: async (p) => p !== "src/missing.ts",
  isExistingTest: async (p) => p === "test/old.test.ts",
  scanSecrets: (t) => (t.includes("AKIA") ? "aws_access_key" : null),
  ...over,
});

describe("triage output", () => {
  it("accepts guidance with steps and rejects anything off-schema", async () => {
    expect((await validateTriage(good, checks(), "openai")).action).toBe("guidance");
    expect((await validateTriage({ ...good, extra: 1 }, checks(), "openai")).action).toBe("escalate");
    expect((await validateTriage({ ...good, steps: [] }, checks(), "openai")).action).toBe("escalate");
    expect((await validateTriage({ ...good, cause: "made_up" }, checks(), "openai")).action).toBe("escalate");
    expect((await validateTriage("not json", checks(), "openai")).action).toBe("escalate");
    expect(TriageOutputSchema.safeParse({ ...good, decision: "escalate", escalateReason: "" }).success).toBe(false);
  });

  it.each(["needs_protected_path", "veto_disputed", "underspecified_issue"])("always escalates for cause %s, whatever decision says", async (cause) => {
    const v = await validateTriage({ ...good, cause, escalateReason: "owner call" }, checks(), "openai");
    expect(v).toMatchObject({ action: "escalate", cause });
  });

  it("an explicit escalate carries its cause and reason, and can never become a retry", async () => {
    const v = await validateTriage({ ...good, decision: "escalate", cause: "veto_disputed", escalateReason: "the veto looks wrong" }, checks(), "openai");
    expect(v).toEqual({ action: "escalate", cause: "veto_disputed", reason: "the veto looks wrong" });
  });

  it("rejects guidance naming a protected path, .agents, an existing test, a missing file or a secret", async () => {
    const withStep = (s: string) => ({ ...good, steps: [s] });
    expect(await validateTriage(withStep("edit `protected/x.ts`"), checks(), "o")).toMatchObject({ action: "escalate", cause: "needs_protected_path" });
    expect(await validateTriage(withStep("edit `.agents/archangel.json`"), checks(), "o")).toMatchObject({ action: "escalate", cause: "needs_protected_path" });
    expect(await validateTriage(withStep("update `test/old.test.ts` to match"), checks(), "o")).toMatchObject({ action: "escalate", cause: "invalid" });
    expect(await validateTriage(withStep("change `src/missing.ts`"), checks(), "o")).toMatchObject({ action: "escalate", cause: "invalid" });
    expect(await validateTriage(withStep("use key AKIAABCDEFGHIJKLMNOP"), checks(), "o")).toMatchObject({ action: "escalate", cause: "invalid" });
    expect((await validateTriage(withStep("a plain step with no path, e.g. narrow it"), checks(), "o")).action).toBe("guidance");
  });

  it("the note names the vendor and the steps", async () => {
    const v = await validateTriage(good, checks(), "openai");
    expect(v.action === "guidance" && v.note).toContain("written by openai");
    expect(v.action === "guidance" && v.note).toContain("1. In `src/parse.ts`");
  });

  it("extracts only backticked paths and slash tokens", () => {
    expect(extractPaths("see `a/b.ts:12`, src/x/y.go and https://x.io/z, e.g. nothing, v1.2")).toEqual(["a/b.ts", "src/x/y.go"]);
  });

  it("the prompt frames everything as data and tells the run it cannot overrule a veto", () => {
    const p = buildTriagePrompt({ issueNumber: 1, title: "t", body: "b", code: "review_vetoed", reason: "r", diffText: "d", summary: null, reviews: [{ vendor: "openai", verdict: "veto", findings: [] }] });
    expect(p).toContain("untrusted DATA");
    expect(p).toContain("veto_disputed");
    expect(p).toContain("openai: veto");
  });

  it("only these codes are triaged", () => {
    expect([...TRIAGE_ELIGIBLE_CODES]).toEqual(["review_vetoed", "revision_no_change", "attempt_failed", "gate_failed"]);
  });
});

describe("triage provider", () => {
  const chain = [{ provider: "claude" as const }, { provider: "codex" as const }, { provider: "agy" as const }];
  it("is never the implementer's vendor, never agy, and for a veto must be a vendor that vetoed", () => {
    expect(pickTriageProvider(chain, { code: "review_vetoed", vetoers: ["anthropic", "openai"], implementerVendors: ["anthropic"] })).toMatchObject({ provider: "codex", vendor: "openai" });
    expect(pickTriageProvider(chain, { code: "review_vetoed", vetoers: ["anthropic"], implementerVendors: ["anthropic"] })).toBeNull();
    expect(pickTriageProvider(chain, { code: "review_vetoed", vetoers: ["gemini"], implementerVendors: [] })).toBeNull();
    expect(pickTriageProvider(chain, { code: "gate_failed", vetoers: [], implementerVendors: ["anthropic"] })).toMatchObject({ provider: "codex" });
    expect(pickTriageProvider([{ provider: "agy" }], { code: "gate_failed", vetoers: [], implementerVendors: [] })).toBeNull();
  });
});

describe("factory retry outcomes", () => {
  const base = { phaseKind: "awaiting_gate", doneOutcome: null, reverted: false, disputed: false, ownerActedAfter: false, escalatedAfter: false };
  it("labels from mechanics and owner actions only", () => {
    expect(classifyFactoryOutcome(base)).toBe("pending");
    expect(classifyFactoryOutcome({ ...base, phaseKind: "done", doneOutcome: "merged" })).toBe("success");
    expect(classifyFactoryOutcome({ ...base, phaseKind: "done", doneOutcome: "owner_merged" })).toBe("success");
    expect(classifyFactoryOutcome({ ...base, phaseKind: "needs_you", escalatedAfter: true })).toBe("re_escalated");
    expect(classifyFactoryOutcome({ ...base, phaseKind: "done", doneOutcome: "pr_closed" })).toBe("owner_overrode");
    expect(classifyFactoryOutcome({ ...base, phaseKind: "done", doneOutcome: "owner_merged", escalatedAfter: true, ownerActedAfter: true })).toBe("owner_overrode");
    expect(classifyFactoryOutcome({ ...base, phaseKind: "done", doneOutcome: "merged", reverted: true })).toBe("bad");
    expect(classifyFactoryOutcome({ ...base, phaseKind: "done", doneOutcome: "owner_merged", disputed: true })).toBe("bad");
  });

  const run = (...o: FactoryOutcome[]) => shouldAutoOff(o.map((outcome) => ({ outcome })));
  it("switches off at 3 of the last 5 unmerged, or on any bad one, and ignores pending", () => {
    expect([FACTORY_AUTO_OFF_WINDOW, FACTORY_AUTO_OFF_UNMERGED]).toEqual([5, 3]);
    expect(run("success", "success", "re_escalated", "owner_overrode").off).toBe(false);
    expect(run("success", "re_escalated", "owner_overrode", "re_escalated").off).toBe(true);
    expect(run("re_escalated", "re_escalated", "success", "success", "success", "success").off).toBe(false); // only the last five count
    expect(run("success", "bad").off).toBe(true);
    expect(run("pending", "pending", "pending").off).toBe(false);
  });
});
