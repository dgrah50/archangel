import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const GatePolicySchema = z.object({
  maxNonTestLines: z.number().int().min(1).default(150),
  maxTotalLines: z.number().int().min(1).default(300),
  maxFiles: z.number().int().min(1).default(5),
  extraProtectedPaths: z.array(z.string().min(1)).default([]),
});

export type GatePolicy = z.infer<typeof GatePolicySchema>;

export const LandingJsonSchema = z.object({
  maxNonTestLines: z.number().int().min(1).optional(),
  maxTotalLines: z.number().int().min(1).optional(),
  maxFiles: z.number().int().min(1).optional(),
  extraProtectedPaths: z.array(z.string().min(1)).optional(),
  requiredChecks: z.array(z.string().min(1)).optional(),
  reviewRubric: z.string().optional(),
});

export type LandingJson = z.infer<typeof LandingJsonSchema>;

export const LabelsSchema = z.object({
  readyForAgent: z.string().default("ready-for-agent"),
  paused: z.string().default("factory:paused"),
  stop: z.string().default("factory:stop"),
  needsYou: z.string().default("needs-you"),
  disagree: z.string().default("factory:disagree"),
});

export const ConfigSchema = z.object({
  // Target repository
  githubOwner: z.string().min(1).default("dgrah50"),
  githubRepo: z.string().min(1).default("gijq"),
  defaultBranch: z.string().min(1).default("main"),
  language: z.enum(["go"]).default("go"),
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
  }),
  requiredChecks: z
    .array(z.string().min(1))
    .default(["Gate", "Test (ubuntu-latest)", "Test (macos-latest)"]),
  reviewRubric: z.string().optional(),

  labels: LabelsSchema.default({
    readyForAgent: "ready-for-agent",
    paused: "factory:paused",
    stop: "factory:stop",
    needsYou: "needs-you",
    disagree: "factory:disagree",
  }),

  // Models & optional notifications/handoff
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
});

export type ArchangelConfig = z.infer<typeof ConfigSchema>;

const HostProjectYamlSchema = z.object({
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must be 'owner/name'"),
  defaultBranch: z.string().min(1).default("main"),
  language: z.enum(["go"]).default("go"),
  workspace: z.enum(["local-clone"]).default("local-clone"),
  githubInstallationId: z.number().int().positive().optional(),
  shadowMode: z.boolean().default(true),
  maxConcurrentThreads: z.number().int().min(1).max(3).default(2),
  maxAutoMergesPerDay: z.number().int().min(1).default(3),
  requiredChecks: z
    .array(z.string().min(1))
    .default(["Gate", "Test (ubuntu-latest)", "Test (macos-latest)"]),
  gate: GatePolicySchema.default({
    maxNonTestLines: 150,
    maxTotalLines: 300,
    maxFiles: 5,
    extraProtectedPaths: [],
  }),
  reviewRubric: z.string().optional(),
});

export const HostYamlSchema = z.object({
  ownerUserId: z.number().int().positive(),
  dataDir: z.string().min(1).default(".archangel"),
  gateBinaryPath: z.string().min(1).optional(),
  pollIntervalMs: z.number().int().min(5000).default(30_000),
  maxDailyUsd: z.number().positive().default(20),
  dailyTimezone: z.string().min(1).default("America/New_York"),
  claudeModel: z.string().default("claude-sonnet-4-6"),
  openaiReviewerModel: z.string().default("gpt-5.4"),
  geminiReviewerModel: z.string().default("gemini-2.5-pro"),
  paseoHost: z.string().optional(),
  paseoHome: z.string().optional(),
  labels: LabelsSchema.optional(),
  projects: z.array(HostProjectYamlSchema).min(1),
});

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
  gateBinaryPath: string;
}

export function resolvePaths(
  cfg: Pick<
    ArchangelConfig,
    "dataDir" | "ledgerDbPath" | "mastraDbPath" | "brokerBareRepoPath" | "clonesDir" | "gateBinaryPath"
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
    gateBinaryPath: cfg.gateBinaryPath
      ? path.resolve(cfg.gateBinaryPath)
      : path.resolve("gate/archangel-gate"),
  };
}

/**
 * Merges optional repo-side `.agents/landing.json` (read strictly from `main` tip)
 * onto host policy. Repo config can ONLY tighten bounds or add extra checks/protected paths,
 * never loosen host limits (ADR-0004).
 */
export function mergeLandingJson(
  hostGate: GatePolicy,
  hostRequiredChecks: string[],
  hostRubric: string | undefined,
  landingJsonRaw: string | null | undefined,
): { gate: GatePolicy; requiredChecks: string[]; reviewRubric?: string } {
  if (!landingJsonRaw || !landingJsonRaw.trim()) {
    return { gate: hostGate, requiredChecks: hostRequiredChecks, reviewRubric: hostRubric };
  }
  const parsed = LandingJsonSchema.parse(JSON.parse(landingJsonRaw));
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
        language: proj.language,
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
        gateBinaryPath: host.gateBinaryPath ?? (env.ARCHANGEL_GATE_BINARY || undefined),
        pollIntervalMs: host.pollIntervalMs,
        maxDailyUsd: host.maxDailyUsd,
        dailyTimezone: host.dailyTimezone,
        maxConcurrentThreads: proj.maxConcurrentThreads,
        maxAutoMergesPerDay: proj.maxAutoMergesPerDay,
        shadowMode: proj.shadowMode,
        requiredChecks: proj.requiredChecks,
        gate: proj.gate,
        reviewRubric: proj.reviewRubric,
        labels: host.labels,
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
    githubOwner: env.ARCHANGEL_GITHUB_OWNER ?? "dgrah50",
    githubRepo: env.ARCHANGEL_GITHUB_REPO ?? "gijq",
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
    gateBinaryPath: env.ARCHANGEL_GATE_BINARY || undefined,
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
