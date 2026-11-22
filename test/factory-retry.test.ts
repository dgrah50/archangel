import { describe, expect, it } from "vitest";
import { buildImplementPrompt, buildRevisionPrompt, formatFactoryNote } from "../src/agents/prompts.js";
import { KERNEL, Workflow, classifyChange, loosens, resolveWorkflow } from "../src/core/workflow.js";
import { Ledger } from "../src/ledger/store.js";
import { hostInput, workflowFile } from "./helpers/workflow.js";

const caps = { perThread: KERNEL.factoryRetriesPerThread, perRepoPerDay: KERNEL.factoryRetriesPerRepoPerDay };
const claim = (l: Ledger, n: number, now = 1_000_000, guidance: string | null = "note") =>
  l.claimFactoryRetry(n, { code: "merge_conflict", guidance, ...caps }, now);
const thread = (l: Ledger, n: number) => l.upsertThread({ issueNumber: n, title: `t${n}`, bodySha256: "x" });

describe("claimFactoryRetry", () => {
  it("allows one per Thread for life, records it under the factory actor and keeps the note", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    try {
      thread(l, 1);
      expect(claim(l, 1)).toBe(true);
      expect(l.getThread(1)).toMatchObject({ factoryRetries: 1, factoryGuidance: "note" });
      expect(claim(l, 1, 2_000_000)).toBe(false); // non-renewable
      const rows = l.listAudit({ topicPrefix: "factory/retry" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: "factory", issueNumber: 1 });
    } finally {
      l.close();
    }
  });

  it("caps a repo at three in any 24 hours, and the window rolls", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    try {
      for (const n of [1, 2, 3, 4]) thread(l, n);
      expect([1, 2, 3].map((n) => claim(l, n))).toEqual([true, true, true]);
      expect(claim(l, 4)).toBe(false);
      expect(claim(l, 4, 1_000_000 + 86_400_000 + 1)).toBe(true);
    } finally {
      l.close();
    }
  });

  it("is refused once the owner has acted on the Thread (a reply or a retry), and an owner retry clears the note", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    try {
      thread(l, 1);
      thread(l, 2);
      l.setOwnerReply(1, "do it this way");
      expect(claim(l, 1)).toBe(false);
      expect(claim(l, 2)).toBe(true);
      l.grantRetryBudget(2);
      expect(l.getThread(2)?.factoryGuidance).toBeNull();
      expect(l.getThread(2)?.factoryRetries).toBe(1); // still spent: the owner's grant does not renew it
      expect(claim(l, 2, 3_000_000)).toBe(false);
    } finally {
      l.close();
    }
  });

});

describe("escalations.factoryRetry", () => {
  const resolve = (file: Record<string, unknown>, host = {}) =>
    resolveWorkflow(hostInput(host), { repo: "a/b", mainSha: "m", fileRaw: JSON.stringify(file), scoutPrompts: {} });
  const parse = (extra: Record<string, unknown>) => Workflow.parse(workflowFile([], extra));

  it("the host kill switch turns a repo's once back to off and records the clamp", () => {
    const file = workflowFile([], { escalations: { factoryRetry: "once" } });
    const on = resolve(file);
    expect(on.status === "ok" && on.factoryRetry).toEqual({ value: "once", source: "repo" });
    const off = resolve(file, { factoryRetry: false });
    expect(off.status === "ok" && off.factoryRetry).toEqual({ value: "off", source: "host", declared: "once" });
  });

  it("turning it on loosens (the owner must read it); turning it off tightens", () => {
    const off = parse({});
    const once = parse({ escalations: { factoryRetry: "once" } });
    expect(loosens(classifyChange(off, once))).toBe(true);
    expect(classifyChange(once, off)).toEqual([{ field: "escalations.factoryRetry", direction: "tighten" }]);
    expect(classifyChange(off, parse({}))).toEqual([]);
  });
});

describe("the factory note", () => {
  const base = { issueNumber: 1, title: "t", body: "b", repoName: "a/b" };
  const NOTE = "MACHINE-GUIDANCE-TEXT";
  const REPLY = "OWNER-WORDS";

  it("is labelled as machine-written and kept apart from the owner reply, in every implementer prompt", () => {
    const prompts = [
      buildImplementPrompt({ ...base, ownerReply: REPLY, factoryGuidance: NOTE }),
      buildRevisionPrompt({ ...base, gateViolations: [], structuredFindings: [], ownerReply: REPLY, factoryGuidance: NOTE }),
    ];
    for (const p of prompts) {
      expect(p).toContain("BEGIN FACTORY NOTE");
      expect(p).toContain("not by the owner");
      expect(p.indexOf(REPLY)).toBeLessThan(p.indexOf(NOTE)); // owner block first, separate
      expect(p.slice(p.indexOf("BEGIN OWNER REPLY"), p.indexOf("END OWNER REPLY"))).not.toContain(NOTE);
    }
    expect(formatFactoryNote(null)).toEqual([]);
    expect(buildImplementPrompt({ ...base, factoryGuidance: null })).not.toContain("FACTORY NOTE");
  });

});
