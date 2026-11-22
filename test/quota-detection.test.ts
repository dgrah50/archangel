import { describe, expect, it } from "bun:test";
import { isRateLimitOrQuotaError } from "../src/agents/subscription-implementer.js";

describe("isRateLimitOrQuotaError", () => {
  it("does not mistake ordinary tool or test output for a quota error", () => {
    for (const text of [
      "--- FAIL: TestParse (0.00s)\n    foo_test.go:429: expected 3, got 4",
      "fatal error: runtime: out of memory: memory exhausted",
      "listening on port 14290",
      "the build cache capacity was resized",
      "panic: connection overloaded handler removed",
      "retry in 3 attempts; try again later in the pipeline",
    ]) {
      expect(isRateLimitOrQuotaError(text), text).toBe(false);
    }
  });

});
