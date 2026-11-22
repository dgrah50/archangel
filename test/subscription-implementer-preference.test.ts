import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";
import type { ImplementInput } from "../src/agents/implementer.js";

describe("subscription implementer vendor preference", () => {
  it("tries a preferred vendor first while keeping cooldown fallback behavior", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-preference-test-"));
    const calls: string[] = [];
    const cooling = new Set<string>();
    const impl = new SubscriptionImplementer({
      chain: [{ provider: "codex" }, { provider: "agy" }],
      transcriptsDir: path.join(tmp, "transcripts"),
      cooldowns: {
        isCoolingDown: (provider) => cooling.has(provider),
        recordCooldown: () => undefined,
      },
      invoker: async ({ provider }) => {
        calls.push(provider);
        return { code: 0, stdout: "{}", stderr: "", aborted: false };
      },
    });
    const input = {
      issueNumber: 8,
      cloneDir: tmp,
      prompt: "revise",
      abortController: new AbortController(),
      maxTurns: 1,
      timeoutMs: 1000,
      maxBudgetUsd: 1,
      // Keep the test compilable against the pre-fix ImplementInput API to reproduce its ignored hint.
      preferVendors: ["gemini"],
    } as ImplementInput;

    try {
      await impl.run(input);
      expect(calls).toEqual(["agy"]);

      calls.length = 0;
      cooling.add("agy");
      await impl.run({ ...input, issueNumber: 9 });
      expect(calls).toEqual(["codex"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
