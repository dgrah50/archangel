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

});

