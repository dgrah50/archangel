import { z } from "zod";
import type { ReviewFinding, ReviewerVendor, ReviewVerdict } from "../ledger/schema.js";
import { buildGeminiAdversarialPrompt, buildOpenAiReviewerPrompt } from "./prompts.js";

export const ReviewFindingSchema = z.object({
  file: z.string().min(1),
  line: z.preprocess((v) => (v === null ? undefined : v), z.number().int().positive().optional()),
  severity: z.enum(["blocker", "major", "minor"]),
  summary: z.string().min(1),
  suggestion: z.preprocess((v) => (v === null ? undefined : v), z.string().optional()),
});

export const ReviewVerdictSchema = z.object({
  verdict: z.enum(["approve", "veto"]),
  findings: z.array(ReviewFindingSchema),
});

export type ParsedReviewOutput = z.infer<typeof ReviewVerdictSchema>;

export interface ReviewRequest {
  issueNumber: number;
  title: string;
  body: string;
  headSha: string;
  diffText: string;
  touchedFiles: Record<string, string>;
  reviewRubric?: string;
  repoInstructions?: string | null;
  skipVendors?: ReviewerVendor[];
  excludeVendors?: ReviewerVendor[];
  /** Aborted when the daemon stops: a reviewer CLI still running is killed, and its vendor is reported as an error. */
  signal?: AbortSignal;
}

export interface VendorReviewResult {
  vendor: ReviewerVendor;
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  costUsd: number;
  /** Replay provenance: who actually reviewed, and with which prompt template. */
  provider?: string;
  model?: string | null;
  /** Which configured account (login) of the vendor reviewed. */
  accountId?: string;
  promptSha256?: string;
}

export interface ReviewBatchOutcome {
  results: VendorReviewResult[];
  /** `retryAt`: when the vendor's logins are all at a usage limit, the time the first is usable again. */
  errors: Array<{ vendor: ReviewerVendor; error: string; retryAt?: number }>;
}

/** The two reviewer prompt templates. Eval swaps these to score a candidate wording against the current one. */
export interface ReviewPromptBuilders {
  contract: (req: ReviewRequest) => string;
  adversarial: (req: ReviewRequest) => string;
}
export const DEFAULT_REVIEW_PROMPTS: ReviewPromptBuilders = {
  contract: (req) => buildOpenAiReviewerPrompt(req),
  adversarial: (req) => buildGeminiAdversarialPrompt(req),
};

export interface ReviewerSuite {
  reviewAll(req: ReviewRequest): Promise<ReviewBatchOutcome>;
}

/**
 * Parses model output strictly against ReviewVerdictSchema.
 * Per ADR-0003 & Pine: missing or unparseable verdicts ALWAYS count as veto.
 */
export function parseStrictVerdict(raw: unknown): ParsedReviewOutput {
  const parsed = ReviewVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      verdict: "veto",
      findings: [
        {
          file: "<review>",
          severity: "blocker",
          summary: `Unparseable or missing structured reviewer verdict: ${parsed.error.issues
            .map((i) => i.message)
            .join("; ")}`,
        },
      ],
    };
  }
  return parsed.data;
}
