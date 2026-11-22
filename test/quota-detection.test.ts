import { describe, expect, it } from "bun:test";
import { classifyCliFailure, isRateLimitOrQuotaError } from "../src/agents/subscription-implementer.js";

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

  it("classifies the cause from stderr and the result envelope, and ignores status-like numbers inside other tokens", () => {
    expect(classifyCliFailure({ stdout: '{"type":"result","is_error":true,"terminal_reason":"prompt_too_long","result":"Prompt is too long"}', stderr: "" })).toBe("context_overflow");
    expect(classifyCliFailure({ stdout: "", stderr: "Not logged in. Please run /login" })).toBe("auth");
    expect(classifyCliFailure({ stdout: "", stderr: "API Error: 503 service unavailable" })).toBe("provider_network");
    expect(classifyCliFailure({ stdout: "FAIL: ECONNRESET in test output", stderr: "foo_test.go:429 took 15290ms at c401f4b" })).toBe("unknown");
  });
});
