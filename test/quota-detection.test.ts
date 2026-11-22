import { describe, expect, it } from "vitest";
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

  it("still recognises real quota and rate-limit messages from the subscription CLIs", () => {
    for (const text of [
      "HTTP 429: usage limit reached, try again later",
      "stream error: exceeded retry limit, last status: 429 Too Many Requests",
      "You've hit your usage limit. Upgrade to Pro or try again at 3:14 PM.",
      "Claude AI usage limit reached|1760000000",
      "5-hour limit reached - resets 3pm",
      '{"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      "status: RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'GenerateContent requests'",
      "Error 429: capacity exhausted, please retry",
      "status code 429",
    ]) {
      expect(isRateLimitOrQuotaError(text), text).toBe(true);
    }
  });
});
