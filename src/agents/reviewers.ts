import fs from "node:fs";
import path from "node:path";
import { timeReview } from "../core/telemetry.js";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { LibSQLStore } from "@mastra/libsql";
import { z } from "zod";
import type { ReviewFinding, ReviewerVendor, ReviewVerdict } from "../ledger/schema.js";
import { buildGeminiAdversarialPrompt, buildOpenAiReviewerPrompt, promptTemplateSha } from "./prompts.js";

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
  skipVendors?: ReviewerVendor[];
  excludeVendors?: ReviewerVendor[];
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
  errors: Array<{ vendor: ReviewerVendor; error: string }>;
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

/** Conservative per-million-token pricing table for daily $20 cap accounting (B9). */
const TOKEN_RATES_PER_M: Record<ReviewerVendor, { input: number; output: number }> = {
  openai: { input: 2.5, output: 10.0 },
  gemini: { input: 1.25, output: 10.0 },
  anthropic: { input: 3.0, output: 15.0 },
};

export function estimateReviewCostUsd(
  vendor: ReviewerVendor,
  usage?: { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number },
): number {
  if (!usage) return 0;
  const input = usage.inputTokens ?? usage.promptTokens ?? 0;
  const output = usage.outputTokens ?? usage.completionTokens ?? 0;
  const rate = TOKEN_RATES_PER_M[vendor];
  return (input / 1_000_000) * rate.input + (output / 1_000_000) * rate.output;
}

export interface MastraReviewerOptions {
  openaiApiKey: string;
  googleApiKey: string;
  openaiModel: string;
  geminiModel: string;
  mastraDbPath: string;
}

export function createArchangelMastra(opts: MastraReviewerOptions): {
  mastra: Mastra;
  openaiAgent: Agent;
  geminiAgent: Agent;
} {
  const openai = createOpenAI({ apiKey: opts.openaiApiKey });
  const google = createGoogleGenerativeAI({ apiKey: opts.googleApiKey });

  const openaiAgent = new Agent({
    id: "archangel-openai-reviewer",
    name: "Archangel OpenAI Reviewer",
    instructions:
      "You are an independent read-only code reviewer. Verify the new test matches the issue contract and the fix is sound. Return strictly structured JSON.",
    model: openai(opts.openaiModel),
  });

  const geminiAgent = new Agent({
    id: "archangel-gemini-adversarial-reviewer",
    name: "Archangel Gemini Adversarial Reviewer",
    instructions:
      "You are an independent adversarial code reviewer. Actively try to break the fix and find edge cases, panics, or flawed tests. Return strictly structured JSON.",
    model: google(opts.geminiModel),
  });

  if (opts.mastraDbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(opts.mastraDbPath)), { recursive: true });
  }

  const mastra = new Mastra({
    agents: { openaiAgent, geminiAgent },
    storage: new LibSQLStore({
      id: "archangel-mastra-storage",
      url: opts.mastraDbPath === ":memory:" ? ":memory:" : `file:${opts.mastraDbPath}`,
    }),
  });

  return { mastra, openaiAgent, geminiAgent };
}

export class MastraReviewerSuite implements ReviewerSuite {
  private readonly openaiAgent: Agent;
  private readonly geminiAgent: Agent;
  private readonly models: Record<"openai" | "gemini", string>;

  constructor(opts: MastraReviewerOptions) {
    this.models = { openai: opts.openaiModel, gemini: opts.geminiModel };
    const { openaiAgent, geminiAgent } = createArchangelMastra(opts);
    this.openaiAgent = openaiAgent;
    this.geminiAgent = geminiAgent;
  }

  async reviewAll(req: ReviewRequest): Promise<ReviewBatchOutcome> {
    const skip = new Set(req.skipVendors ?? []);
    const entries: Array<{ vendor: ReviewerVendor; promise: Promise<VendorReviewResult> }> = [];

    if (!skip.has("openai")) {
      entries.push({
        vendor: "openai",
        promise: timeReview("openai", this.runOne("openai", this.openaiAgent, buildOpenAiReviewerPrompt(req), "review_contract")),
      });
    }
    if (!skip.has("gemini")) {
      entries.push({
        vendor: "gemini",
        promise: timeReview("gemini", this.runOne("gemini", this.geminiAgent, buildGeminiAdversarialPrompt(req), "review_adversarial")),
      });
    }

    // Use Promise.allSettled so surviving vendor verdicts and costs are NEVER lost when one vendor fails (Opus L4/M5).
    const settled = await Promise.allSettled(entries.map((e) => e.promise));
    const results: VendorReviewResult[] = [];
    const errors: Array<{ vendor: ReviewerVendor; error: string }> = [];

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      const vendor = entries[i]!.vendor;
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
      } else {
        errors.push({
          vendor,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
      }
    }
    return { results, errors };
  }

  private async runOne(
    vendor: ReviewerVendor,
    agent: Agent,
    prompt: string,
    kind: "review_contract" | "review_adversarial",
  ): Promise<VendorReviewResult> {
    const response = await agent.generate(prompt, {
      structuredOutput: {
        schema: ReviewVerdictSchema,
      },
    });
    const parsed = parseStrictVerdict(response.object);
    const usage = response.usage as
      | { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number }
      | undefined;

    return {
      vendor,
      verdict: parsed.verdict,
      findings: parsed.findings,
      costUsd: estimateReviewCostUsd(vendor, usage),
      provider: vendor,
      model: this.models[vendor as "openai" | "gemini"] ?? null,
      promptSha256: promptTemplateSha(kind),
    };
  }
}
