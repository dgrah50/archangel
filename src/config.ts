import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ReviewerVendor } from "./ledger/schema.js";

export const CliProviderSchema = z.enum(["codex", "agy", "claude"]);
export type CliProvider = z.infer<typeof CliProviderSchema>;

export const ProviderEntrySchema = z.object({
  provider: CliProviderSchema,
  model: z.string().min(1).optional(),
});
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

export const AuthModeSchema = z.enum(["subscription", "api"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export function providerToVendor(provider: CliProvider): ReviewerVendor {
  if (provider === "codex") return "openai";
  if (provider === "agy") return "gemini";
  return "anthropic";
}

export const GatePolicySchema = z.object({
  maxNonTestLines: z.number().int().min(1).default(150),
  maxTotalLines: z.number().int().min(1).default(300),
  maxFiles: z.number().int().min(1).default(5),
  extraProtectedPaths: z.array(z.string().min(1)).default([]),
  testFileGlobs: z.array(z.string().min(1)).default([]),
  testDataGlobs: z.array(z.string().min(1)).default([]),
  testBuildCmd: z.string().min(1).optional(),
  baseTestCmd: z.string().min(1).optional(),
  testCmd: z.string().min(1).optional(),
  baseTestRuns: z.number().int().min(1).default(3),
  headTestRuns: z.number().int().min(1).default(2),
});

export type GatePolicy = z.infer<typeof GatePolicySchema>;

/** Repo-owned Archangel policy file, always read from the default branch / base commit. */
export const REPO_POLICY_PATH = ".agents/archangel.json";

export const RepoPolicySchema = z
  .object({
    maxNonTestLines: z.number().int().min(1).optional(),
    maxTotalLines: z.number().int().min(1).optional(),
    maxFiles: z.number().int().min(1).optional(),
    extraProtectedPaths: z.array(z.string().min(1)).optional(),
    testFileGlobs: z.array(z.string().min(1)).optional(),
    testDataGlobs: z.array(z.string().min(1)).optional(),
    testBuildCmd: z.string().min(1).optional(),
    baseTestCmd: z.string().min(1).optional(),
    testCmd: z.string().min(1).optional(),
    baseTestRuns: z.number().int().min(1).optional(),
    headTestRuns: z.number().int().min(1).optional(),
    requiredChecks: z.array(z.string().min(1)).optional(),
    reviewRubric: z.string().optional(),
  })
  .strict();

export type RepoPolicy = z.infer<typeof RepoPolicySchema>;

export const LabelsSchema = z.object({
  readyForAgent: z.string().default("ready-for-agent"),
  paused: z.string().default("factory:paused"),
  stop: z.string().default("factory:stop"),
  needsYou: z.string().default("needs-you"),
  disagree: z.string().default("factory:disagree"),
  agentProposed: z.string().default("agent-proposed"),
});

export const ScoutsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxRunsPerDay: z.number().int().min(1).max(10).default(2),
  maxOpenProposals: z.number().int().min(1).max(10).default(3),
  /** Hard host cap on Scout proposals promoted without the owner (only for Scouts with `autoPromote: true`). */
  maxAutoPromotionsPerDay: z.number().int().min(0).max(5).default(1),
});

export type ScoutsConfig = z.infer<typeof ScoutsConfigSchema>;

export const ConfigSchema = z.object({
  // Target repository (language-agnostic — repo owns verification via .pre-commit-config.yaml + .agents/archangel.json)
  githubOwner: z.string().min(1),
  githubRepo: z.string().min(1),
  defaultBranch: z.string().min(1).default("main"),
  workspace: z.enum(["local-clone"]).default("local-clone"),
  ownerUserId: z.number().int().positive(),

  // GitHub App auth (no PATs — ADR-0004)
  githubAppId: z.string().min(1),
  githubInstallationId: z.number().int().positive(),
  githubPrivateKeyPem: z.string().min(1),
  githubAppBotUserId: z.number().int().positive().optional(),

  // Data paths (separate DB files to prevent SQLITE_BUSY — ADR-0001)
  dataDir: z.string().min(1).default(".archangel"),
  ledgerDbPath: z.string().min(1).optional(),
  mastraDbPath: z.string().min(1).optional(),
  brokerBareRepoPath: z.string().min(1).optional(),
  clonesDir: z.string().min(1).optional(),

  // Concurrency, spend & merge bounds
  maxConcurrentThreads: z.number().int().min(1).max(3).default(2),
  pollIntervalMs: z.number().int().min(5000).default(30_000),
  maxDailyUsd: z.number().positive().default(20),
  dailyTimezone: z.string().min(1).default("America/New_York"),
  maxAutoMergesPerDay: z.number().int().min(1).default(3),
  /** Autonomous steps (Attempt starts + auto-merges) allowed before the owner is next heard from. */
  maxAutonomousStepsWithoutOwner: z.number().int().min(1).default(25),
  shadowMode: z.boolean().default(true),
  maxImplementAttemptsPerThread: z.number().int().min(1).default(3),
  maxRevisionsPerThread: z.number().int().min(0).default(1),
  maxRebasesPerThread: z.number().int().min(0).default(1),
  implementMaxTurns: z.number().int().min(1).default(40),
  implementTimeoutMs: z.number().int().min(30_000).default(20 * 60_000),
  setupTimeoutMs: z.number().int().min(5_000).default(5 * 60_000),
  staleLeaseMs: z.number().int().min(10_000).default(3 * 60_000),
  gateStartGraceMs: z.number().int().min(10_000).default(5 * 60_000),
  gateTimeoutMs: z.number().int().min(60_000).default(60 * 60_000),
  reviewerOutageMaxMs: z.number().int().min(60_000).default(6 * 60 * 60_000),

  // Per-project Gate policy & required checks (hard-coded; App has no administration:read)
  gate: GatePolicySchema.default({
    maxNonTestLines: 150,
    maxTotalLines: 300,
    maxFiles: 5,
    extraProtectedPaths: [],
    testFileGlobs: [],
    testDataGlobs: [],
    baseTestRuns: 3,
    headTestRuns: 2,
  }),
  requiredChecks: z.array(z.string().min(1)).default(["Gate"]),
  reviewRubric: z.string().optional(),

  labels: LabelsSchema.default({
    readyForAgent: "ready-for-agent",
    paused: "factory:paused",
    stop: "factory:stop",
    needsYou: "needs-you",
    disagree: "factory:disagree",
    agentProposed: "agent-proposed",
  }),
  scouts: ScoutsConfigSchema.default({
    enabled: false,
    maxRunsPerDay: 2,
    maxOpenProposals: 3,
    maxAutoPromotionsPerDay: 1,
  }),

  // Models, auth mode (native CLI subscriptions vs metered API keys), & optional notifications/handoff
  authMode: AuthModeSchema.default("api"),
  implementerChain: z
    .array(ProviderEntrySchema)
    .min(1)
    .default([{ provider: "codex" }, { provider: "agy" }]),
  reviewerChain: z
    .array(ProviderEntrySchema)
    .min(2)
    .default([{ provider: "agy" }, { provider: "claude" }, { provider: "codex" }]),
  anthropicApiKey: z.string().min(1).optional(),
  openaiApiKey: z.string().min(1).optional(),
  googleApiKey: z.string().min(1).optional(),
  claudeModel: z.string().default("claude-sonnet-4-6"),
  openaiReviewerModel: z.string().default("gpt-5.4"),
  geminiReviewerModel: z.string().default("gemini-2.5-pro"),

  paseoHost: z.string().optional(),
  paseoHome: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
}).superRefine((cfg, ctx) => {
  if (cfg.scouts.enabled && (!cfg.githubAppBotUserId || cfg.githubAppBotUserId <= 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["githubAppBotUserId"],
      message:
        "scouts.enabled requires githubAppBotUserId (set ARCHANGEL_GITHUB_BOT_USER_ID in .env) to safely verify bot-authored proposals",
    });
  }
});

export type ArchangelConfig = z.infer<typeof ConfigSchema>;

const HostProjectYamlSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must be 'owner/name'"),
  defaultBranch: z.string().min(1).default("main"),
  workspace: z.enum(["local-clone"]).default("local-clone"),
  githubInstallationId: z.number().int().positive().optional(),
  shadowMode: z.boolean().default(true),
  maxConcurrentThreads: z.number().int().min(1).max(3).default(2),
  maxAutoMergesPerDay: z.number().int().min(1).default(3),
  requiredChecks: z.array(z.string().min(1)).default(["Gate"]),
  gate: GatePolicySchema.default({
    maxNonTestLines: 150,
    maxTotalLines: 300,
    maxFiles: 5,
    extraProtectedPaths: [],
    testFileGlobs: [],
    testDataGlobs: [],
    baseTestRuns: 3,
    headTestRuns: 2,
  }),
  reviewRubric: z.string().optional(),
  scouts: ScoutsConfigSchema.default({
    enabled: false,
    maxRunsPerDay: 2,
    maxOpenProposals: 3,
    maxAutoPromotionsPerDay: 1,
  }),
});

export const HostYamlSchema = z.object({
  ownerUserId: z.number().int().positive(),
  dataDir: z.string().min(1).default(".archangel"),
  pollIntervalMs: z.number().int().min(5000).default(30_000),
  maxDailyUsd: z.number().positive().default(20),
  dailyTimezone: z.string().min(1).default("America/New_York"),
  authMode: AuthModeSchema.default("subscription"),
  implementerChain: z
    .array(ProviderEntrySchema)
    .min(1)
    .default([{ provider: "codex" }, { provider: "agy" }]),
  reviewerChain: z
    .array(ProviderEntrySchema)
    .min(2)
    .default([{ provider: "agy" }, { provider: "claude" }, { provider: "codex" }]),
  claudeModel: z.string().default("claude-sonnet-4-6"),
  openaiReviewerModel: z.string().default("gpt-5.4"),
  geminiReviewerModel: z.string().default("gemini-2.5-pro"),
  paseoHost: z.string().optional(),
  paseoHome: z.string().optional(),
  labels: LabelsSchema.optional(),
  projects: z.array(HostProjectYamlSchema).min(1),
});

/**
 * Resolves the 2 independent reviewer vendors required for a project (ADR-0003: implementer != reviewer).
 */
export function resolveRequiredReviewers(
  cfg: Pick<ArchangelConfig, "authMode" | "implementerChain" | "reviewerChain">,
  threadImplementerVendors: ReviewerVendor[] = [],
): ReviewerVendor[] {
  if (cfg.authMode === "api") {
    return ["openai", "gemini"];
  }
  // When actual implementer vendor(s) are known for this thread, block ONLY those vendors
  // (so a provider skipped via cooldown can still review cleanly — Opus B1).
  const blocked = new Set<ReviewerVendor>(
    threadImplementerVendors.length > 0
      ? threadImplementerVendors
      : [providerToVendor(cfg.implementerChain[0]!.provider)],
  );
  const chosen: ReviewerVendor[] = [];
  for (const entry of cfg.reviewerChain) {
    const v = providerToVendor(entry.provider);
    if (blocked.has(v) || chosen.includes(v)) continue;
    chosen.push(v);
    if (chosen.length === 2) break;
  }
  return chosen;
}

function resolvePrivateKeyPem(env: NodeJS.ProcessEnv): string | undefined {
  if (env.ARCHANGEL_GITHUB_PRIVATE_KEY_PEM && env.ARCHANGEL_GITHUB_PRIVATE_KEY_PEM.trim()) {
    return env.ARCHANGEL_GITHUB_PRIVATE_KEY_PEM.replace(/\\n/g, "\n");
  }
  if (env.ARCHANGEL_GITHUB_PRIVATE_KEY_PATH && env.ARCHANGEL_GITHUB_PRIVATE_KEY_PATH.trim()) {
    const keyPath = path.resolve(env.ARCHANGEL_GITHUB_PRIVATE_KEY_PATH.trim());
    return fs.readFileSync(keyPath, "utf8");
  }
  return undefined;
}

export interface ResolvedPaths {
  dataDir: string;
  ledgerDbPath: string;
  mastraDbPath: string;
  brokerBareRepoPath: string;
  clonesDir: string;
  transcriptsDir: string;
}

export function resolvePaths(
  cfg: Pick<
    ArchangelConfig,
    "dataDir" | "ledgerDbPath" | "mastraDbPath" | "brokerBareRepoPath" | "clonesDir"
  > & { githubOwner?: string; githubRepo?: string },
): ResolvedPaths {
  const dataDir = path.resolve(cfg.dataDir);
  const projectSlug =
    cfg.githubOwner && cfg.githubRepo ? `${cfg.githubOwner}__${cfg.githubRepo}` : null;
  const projectDir = projectSlug ? path.join(dataDir, "projects", projectSlug) : dataDir;
  return {
    dataDir,
    ledgerDbPath: cfg.ledgerDbPath ? path.resolve(cfg.ledgerDbPath) : path.join(dataDir, "ledger.db"),
    mastraDbPath: cfg.mastraDbPath ? path.resolve(cfg.mastraDbPath) : path.join(dataDir, "mastra.db"),
    brokerBareRepoPath: cfg.brokerBareRepoPath
      ? path.resolve(cfg.brokerBareRepoPath)
      : path.join(projectDir, "broker.git"),
    clonesDir: cfg.clonesDir ? path.resolve(cfg.clonesDir) : path.join(projectDir, "clones"),
    transcriptsDir: path.join(projectDir, "transcripts"),
  };
}

/**
 * Merges optional repo-side `.agents/archangel.json` (read strictly from `main` tip)
 * onto host policy. Repo config can ONLY tighten bounds or add extra checks/protected paths,
 * never loosen host limits (ADR-0004).
 */
export function mergeRepoPolicy(
  hostGate: GatePolicy,
  hostRequiredChecks: string[],
  hostRubric: string | undefined,
  repoPolicyRaw: string | null | undefined,
): { gate: GatePolicy; requiredChecks: string[]; reviewRubric?: string } {
  if (!repoPolicyRaw || !repoPolicyRaw.trim()) {
    return { gate: hostGate, requiredChecks: hostRequiredChecks, reviewRubric: hostRubric };
  }
  const parsed = RepoPolicySchema.parse(JSON.parse(repoPolicyRaw));
  const gate: GatePolicy = {
    maxNonTestLines:
      parsed.maxNonTestLines !== undefined
        ? Math.min(hostGate.maxNonTestLines, parsed.maxNonTestLines)
        : hostGate.maxNonTestLines,
    maxTotalLines:
      parsed.maxTotalLines !== undefined
        ? Math.min(hostGate.maxTotalLines, parsed.maxTotalLines)
        : hostGate.maxTotalLines,
    maxFiles:
      parsed.maxFiles !== undefined
        ? Math.min(hostGate.maxFiles, parsed.maxFiles)
        : hostGate.maxFiles,
    extraProtectedPaths: [
      ...new Set([...hostGate.extraProtectedPaths, ...(parsed.extraProtectedPaths ?? [])]),
    ],
    testFileGlobs:
      parsed.testFileGlobs && parsed.testFileGlobs.length > 0
        ? parsed.testFileGlobs
        : hostGate.testFileGlobs,
    testDataGlobs:
      parsed.testDataGlobs && parsed.testDataGlobs.length > 0
        ? parsed.testDataGlobs
        : hostGate.testDataGlobs,
    testBuildCmd: parsed.testBuildCmd ?? hostGate.testBuildCmd,
    baseTestCmd: parsed.baseTestCmd ?? hostGate.baseTestCmd,
    testCmd: parsed.testCmd ?? hostGate.testCmd,
    baseTestRuns:
      parsed.baseTestRuns !== undefined
        ? Math.max(hostGate.baseTestRuns, parsed.baseTestRuns)
        : hostGate.baseTestRuns,
    headTestRuns:
      parsed.headTestRuns !== undefined
        ? Math.max(hostGate.headTestRuns, parsed.headTestRuns)
        : hostGate.headTestRuns,
  };
  const requiredChecks = [
    ...new Set([...hostRequiredChecks, ...(parsed.requiredChecks ?? [])]),
  ];
  const reviewRubric = [hostRubric, parsed.reviewRubric].filter(Boolean).join("\n\n") || undefined;
  return { gate, requiredChecks, reviewRubric };
}

/**
 * Loads multi-project host config from `archangel.yaml` (if present or specified) merged with
 * secrets strictly from `env`, or falls back to single-repo env config.
 */
export function loadProjectConfigs(opts: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ArchangelConfig[] {
  const env = opts.env ?? process.env;
  const candidatePath = opts.configPath ?? env.ARCHANGEL_CONFIG ?? "archangel.yaml";
  const resolvedConfig = path.resolve(candidatePath);

  if (opts.configPath || fs.existsSync(resolvedConfig)) {
    const rawText = fs.readFileSync(resolvedConfig, "utf8");
    const yamlObj = parseYaml(rawText);
    const host = HostYamlSchema.parse(yamlObj);

    return host.projects.map((proj) => {
      const [githubOwner, githubRepo] = proj.repo.split("/") as [string, string];
      return ConfigSchema.parse({
        githubOwner,
        githubRepo,
        defaultBranch: proj.defaultBranch,
        workspace: proj.workspace,
        ownerUserId: host.ownerUserId,
        githubAppId: env.ARCHANGEL_GITHUB_APP_ID,
        githubInstallationId:
          proj.githubInstallationId ??
          (env.ARCHANGEL_GITHUB_INSTALLATION_ID
            ? Number(env.ARCHANGEL_GITHUB_INSTALLATION_ID)
            : undefined),
        githubPrivateKeyPem: resolvePrivateKeyPem(env),
        githubAppBotUserId: env.ARCHANGEL_GITHUB_BOT_USER_ID
          ? Number(env.ARCHANGEL_GITHUB_BOT_USER_ID)
          : undefined,
        dataDir: host.dataDir,
        pollIntervalMs: host.pollIntervalMs,
        maxDailyUsd: host.maxDailyUsd,
        dailyTimezone: host.dailyTimezone,
        maxConcurrentThreads: proj.maxConcurrentThreads,
        maxAutoMergesPerDay: proj.maxAutoMergesPerDay,
        shadowMode: proj.shadowMode,
        requiredChecks: proj.requiredChecks,
        gate: proj.gate,
        reviewRubric: proj.reviewRubric,
        scouts: proj.scouts,
        labels: host.labels,
        authMode: host.authMode,
        implementerChain: host.implementerChain,
        reviewerChain: host.reviewerChain,
        claudeModel: host.claudeModel,
        openaiReviewerModel: host.openaiReviewerModel,
        geminiReviewerModel: host.geminiReviewerModel,
        paseoHost: host.paseoHost ?? (env.PASEO_HOST || undefined),
        paseoHome: host.paseoHome ?? (env.PASEO_HOME || undefined),
        anthropicApiKey: env.ANTHROPIC_API_KEY,
        openaiApiKey: env.OPENAI_API_KEY,
        googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GEMINI_API_KEY,
        telegramBotToken: env.ARCHANGEL_TELEGRAM_BOT_TOKEN || undefined,
        telegramChatId: env.ARCHANGEL_TELEGRAM_CHAT_ID || undefined,
      });
    });
  }

  return [loadConfigFromEnv(env)];
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ArchangelConfig {
  const raw = {
    githubOwner: env.ARCHANGEL_GITHUB_OWNER,
    githubRepo: env.ARCHANGEL_GITHUB_REPO,
    defaultBranch: env.ARCHANGEL_DEFAULT_BRANCH ?? "main",
    ownerUserId: env.ARCHANGEL_OWNER_USER_ID ? Number(env.ARCHANGEL_OWNER_USER_ID) : undefined,
    githubAppId: env.ARCHANGEL_GITHUB_APP_ID,
    githubInstallationId: env.ARCHANGEL_GITHUB_INSTALLATION_ID
      ? Number(env.ARCHANGEL_GITHUB_INSTALLATION_ID)
      : undefined,
    githubPrivateKeyPem: resolvePrivateKeyPem(env),
    githubAppBotUserId: env.ARCHANGEL_GITHUB_BOT_USER_ID
      ? Number(env.ARCHANGEL_GITHUB_BOT_USER_ID)
      : undefined,
    dataDir: env.ARCHANGEL_DATA_DIR ?? ".archangel",
    maxConcurrentThreads: env.ARCHANGEL_MAX_CONCURRENT ? Number(env.ARCHANGEL_MAX_CONCURRENT) : 2,
    pollIntervalMs: env.ARCHANGEL_POLL_MS ? Number(env.ARCHANGEL_POLL_MS) : 30_000,
    maxDailyUsd: env.ARCHANGEL_MAX_DAILY_USD ? Number(env.ARCHANGEL_MAX_DAILY_USD) : 20,
    dailyTimezone: env.ARCHANGEL_TIMEZONE ?? "America/New_York",
    maxAutoMergesPerDay: env.ARCHANGEL_MAX_MERGES_PER_DAY
      ? Number(env.ARCHANGEL_MAX_MERGES_PER_DAY)
      : 3,
    shadowMode: env.ARCHANGEL_SHADOW_MODE !== "false",
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GEMINI_API_KEY,
    claudeModel: env.ARCHANGEL_CLAUDE_MODEL ?? "claude-sonnet-4-6",
    openaiReviewerModel: env.ARCHANGEL_OPENAI_MODEL ?? "gpt-5.4",
    geminiReviewerModel: env.ARCHANGEL_GEMINI_MODEL ?? "gemini-2.5-pro",
    paseoHost: env.PASEO_HOST || undefined,
    paseoHome: env.PASEO_HOME || undefined,
    telegramBotToken: env.ARCHANGEL_TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.ARCHANGEL_TELEGRAM_CHAT_ID || undefined,
  };
  return ConfigSchema.parse(raw);
}
