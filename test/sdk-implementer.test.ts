import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, mock } from "bun:test";

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () =>
    (async function* () {
      yield { type: "result", subtype: "error_max_turns", total_cost_usd: 0.5 };
    })(),
}));

const { ClaudeSdkImplementer } = await import("../src/agents/implementer.js");

describe("ClaudeSdkImplementer", () => {
  it("reports a result that is not a success (turn or budget limit, execution error) as a failure, with its cost", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-impl-"));
    try {
      const impl = new ClaudeSdkImplementer({ apiKey: "k", model: "m", transcriptsDir: dir });
      const res = await impl.run({
        issueNumber: 1, cloneDir: dir, prompt: "p", abortController: new AbortController(), maxTurns: 1, timeoutMs: 5000, maxBudgetUsd: 1, role: "implement",
      });
      expect(res.failure).toBe("error_max_turns");
      expect(res.costUsd).toBeCloseTo(0.5);
      expect(res.aborted).toBe(false);
    } finally {
      await new Promise((r) => setTimeout(r, 100)); // let the transcript stream flush before its directory goes
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
