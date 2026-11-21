import path from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  // Target repository
  githubOwner: z.string().min(1).default("dgrah50"),
  githubRepo: z.string().min(1).default("gijq"),
  defaultBranch: z.string().min(1).default("main"),
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
  gateBinaryPath: z.string().min(1).optional(),

  // Concurrency, spend & merge bounds
  maxConcurrentThreads: z.number().int().min(1).max(3).default(2),
  pollIntervalMs: z.number().int().min(5000).default(30_000),
  maxDailyUsd: z.number().positive().default(20),
  dailyTimezone: z.string().min(1).default("America/New_York"),
  maxAutoMergesPerDay: z.number().int().min(1).default(3),
  shadowMode: z.boolean().default(true),
  maxImplementAttemptsPerThread: z.number().int().min(1).default(3),
  maxRevisionsPerThread: z.number().int().min(0).default(1),
  maxRebasesPerThread: z.number().int().min(0).default(1),
  implementMaxTurns: z.number().int().min(1).default(40),
  implementTimeoutMs: z.number().int().min(30_000).default(20 * 60_000),
  staleLeaseMs: z.number().int().min(10_000).default(3 * 60_000),
  gateStartGraceMs: z.number().int().min(10_000).default(5 * 60_000),
  gateTimeoutMs: z.number().int().min(60_000).default(60 * 60_000),
  reviewerOutageMaxMs: z.number().int().min(60_000).default(6 * 60 * 60_000),

  // Required GitHub check names (hard-coded; App has no administration:read)
  requiredChecks: z
    .array(z.string().min(1))
    .default(["Gate", "Test (ubuntu-latest)", "Test (macos-latest)"]),

  // Labels
  labels: z
    .object({
      readyForAgent: z.string().default("ready-for-agent"),
      paused: z.string().default("factory:paused"),
      stop: z.string().default("factory:stop"),
      needsYou: z.string().default("needs-you"),
      disagree: z.string().default("factory:disagree"),
    })
    .default({
      readyForAgent: "ready-for-agent",
      paused: "factory:paused",
      stop: "factory:stop",
      needsYou: "needs-you",
      disagree: "factory:disagree",
    }),

  // Models & optional isolation/notifications
  anthropicApiKey: z.string().min(1).optional(),
  openaiApiKey: z.string().min(1).optional(),
  googleApiKey: z.string().min(1).optional(),
  claudeModel: z.string().default("claude-sonnet-4-6"),
  openaiReviewerModel: z.string().default("gpt-5.4"),
  geminiReviewerModel: z.string().default("gemini-2.5-pro"),

  // Dedicated macOS worker user (ADR-0004 B1). Empty = advisory local mode with warning.
  workerOsUser: z.string().optional(),

  // Paseo Handoff & Telegram Needs You notifications
  paseoHost: z.string().optional(),
  paseoHome: z.string().optional(),
  telegramBotToken: z.string().optional(),
  telegramChatId: z.string().optional(),
});

export type ArchangelConfig = z.infer<typeof ConfigSchema>;

export interface ResolvedPaths {
  dataDir: string;
  ledgerDbPath: string;
  mastraDbPath: string;
  brokerBareRepoPath: string;
  clonesDir: string;
  transcriptsDir: string;
  gateBinaryPath: string;
}

export function resolvePaths(cfg: Pick<ArchangelConfig, "dataDir" | "ledgerDbPath" | "mastraDbPath" | "brokerBareRepoPath" | "clonesDir" | "gateBinaryPath">): ResolvedPaths {
  const dataDir = path.resolve(cfg.dataDir);
  return {
    dataDir,
    ledgerDbPath: cfg.ledgerDbPath ? path.resolve(cfg.ledgerDbPath) : path.join(dataDir, "ledger.db"),
    mastraDbPath: cfg.mastraDbPath ? path.resolve(cfg.mastraDbPath) : path.join(dataDir, "mastra.db"),
    brokerBareRepoPath: cfg.brokerBareRepoPath
      ? path.resolve(cfg.brokerBareRepoPath)
      : path.join(dataDir, "broker.git"),
    clonesDir: cfg.clonesDir ? path.resolve(cfg.clonesDir) : path.join(dataDir, "clones"),
    transcriptsDir: path.join(dataDir, "transcripts"),
    gateBinaryPath: cfg.gateBinaryPath
      ? path.resolve(cfg.gateBinaryPath)
      : path.resolve("gate/archangel-gate"),
  };
}

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ArchangelConfig {
  const raw = {
    githubOwner: env.ARCHANGEL_GITHUB_OWNER ?? "dgrah50",
    githubRepo: env.ARCHANGEL_GITHUB_REPO ?? "gijq",
    defaultBranch: env.ARCHANGEL_DEFAULT_BRANCH ?? "main",
    ownerUserId: env.ARCHANGEL_OWNER_USER_ID ? Number(env.ARCHANGEL_OWNER_USER_ID) : undefined,
    githubAppId: env.ARCHANGEL_GITHUB_APP_ID,
    githubInstallationId: env.ARCHANGEL_GITHUB_INSTALLATION_ID
      ? Number(env.ARCHANGEL_GITHUB_INSTALLATION_ID)
      : undefined,
    githubPrivateKeyPem: env.ARCHANGEL_GITHUB_PRIVATE_KEY_PEM?.replace(/\\n/g, "\n"),
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
    workerOsUser: env.ARCHANGEL_WORKER_USER || undefined,
    paseoHost: env.PASEO_HOST || undefined,
    paseoHome: env.PASEO_HOME || undefined,
    telegramBotToken: env.ARCHANGEL_TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.ARCHANGEL_TELEGRAM_CHAT_ID || undefined,
  };
  return ConfigSchema.parse(raw);
}
