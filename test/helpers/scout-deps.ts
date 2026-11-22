import type { ReviewerSuite } from "../../src/agents/reviewers.js";
import type { Notifier } from "../../src/core/notifier.js";

/** Reviewer suite that approves everything and records each request (the pitch critic). */
export function approvingReviewers(requests: unknown[] = []): ReviewerSuite {
  return {
    async reviewAll(req) {
      requests.push(req);
      const vendor = (["openai", "gemini", "anthropic"] as const).find((v) => !(req.excludeVendors ?? []).includes(v) && !(req.skipVendors ?? []).includes(v))!;
      return { results: [{ vendor, verdict: "approve", findings: [], costUsd: 0 }], errors: [] };
    },
  };
}

export const quietNotifier: Notifier = { async notifyNeedsYou() {}, async sendDigest() {} };

export const scoutDeps = { reviewers: approvingReviewers(), notifier: quietNotifier };
