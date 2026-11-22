import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { FLEET_SCOUT_NAMES } from "./core/fleet-scouts.js";
import type { ReviewerVendor } from "./ledger/schema.js";

export const CliProviderSchema = z.enum(["codex", "agy", "claude"]);
export type CliProvider = z.infer<typeof CliProviderSchema>;

export const ProviderEntrySchema = z.object({
  provider: CliProviderSchema,
  model: z.string().min(1).optional(),
  /** Restrict this entry to these account ids (of this provider); by default it may use every account of the provider. */
  accounts: z.array(z.string().min(1)).min(1).optional(),
});
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;

/**
 * One login of a subscription CLI. `home` is that CLI's own config dir (CLAUDE_CONFIG_DIR for claude, CODEX_HOME for codex,
 * HOME for agy); the owner logs each account in by hand and Archangel never reads, copies or refreshes a token.
 * Without `home` the account uses the CLI's default home.
 */
export const AccountSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "account id must be a lowercase slug"),
    provider: CliProviderSchema,
    home: z.string().min(1).optional(),
    /** Optional per-account cap on Attempts started per local day. */
    maxAttemptsPerDay: z.number().int().min(1).optional(),
  })
  .strict();
export type Account = z.infer<typeof AccountSchema>;

/**
 * The base case, not a fallback: with no `accounts` list there is exactly one implicit account per provider using the CLI's
 * default home, and its id is the provider name.
 */
export const DEFAULT_ACCOUNTS: Account[] = CliProviderSchema.options.map((provider) => ({ id: provider, provider }));

export function expandHome(p: string, home = os.homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** The single environment variable that points a CLI at this account's login. Empty for an account on the default home. */
export function accountEnv(account: Account | undefined): NodeJS.ProcessEnv {
  if (!account?.home) return {};
  const home = path.resolve(expandHome(account.home));
  if (account.provider === "claude") return { CLAUDE_CONFIG_DIR: home };
  if (account.provider === "codex") return { CODEX_HOME: home };
  return { HOME: home };
}

/** The account an entry runs on: the first account of its provider that the entry allows. (A selector over these comes next.) */
export function accountsFor(accounts: Account[], entry: ProviderEntry): Account[] {
  return accounts.filter((a) => a.provider === entry.provider && (!entry.accounts || entry.accounts.includes(a.id)));
}
export function firstAccount(accounts: Account[], entry: ProviderEntry): Account | undefined {
  return accountsFor(accounts, entry)[0];
}

/** Filesystem checks for configured homes: each must exist, be a directory, and hold a login (non-empty). */
export function accountHomeProblems(accounts: Account[]): Array<{ id: string; problem: string }> {
  const out: Array<{ id: string; problem: string }> = [];
  for (const a of accounts) {
    if (!a.home) continue;
    const dir = path.resolve(expandHome(a.home));
    let entries: string[];
    try {
      if (!fs.statSync(dir).isDirectory()) throw new Error("not a directory");
      entries = fs.readdirSync(dir);
    } catch (err) {
      out.push({ id: a.id, problem: `home ${dir} does not exist or is not a directory (${err instanceof Error ? err.message : String(err)})` });
      continue;
    }
    if (entries.length === 0) out.push({ id: a.id, problem: `home ${dir} is empty: log this account in first` });
  }
  return out;
}

/** Cross-field rules for an accounts list and the chains that use it. */
function checkAccounts(
  accounts: Account[],
  chains: Array<[string, ProviderEntry[]]>,
  addIssue: (path: (string | number)[], message: string) => void,
): void {
  const ids = new Set<string>();
  const homes = new Map<string, string>();
  accounts.forEach((a, i) => {
    if (ids.has(a.id)) addIssue(["accounts", i, "id"], `duplicate account id '${a.id}'`);
    ids.add(a.id);
    if (a.home) {
      const key = path.resolve(expandHome(a.home));
      const other = homes.get(key);
      if (other) addIssue(["accounts", i, "home"], `accounts '${other}' and '${a.id}' share one home: that is one login, not two`);
      homes.set(key, a.id);
    }
  });
  for (const [where, chain] of chains) {
    chain.forEach((entry, i) => {
      if (!accounts.some((a) => a.provider === entry.provider)) {
        addIssue([where, i, "provider"], `${where} names provider '${entry.provider}' but no account of that provider is configured`);
      }
      for (const id of entry.accounts ?? []) {
        const acct = accounts.find((a) => a.id === id);
        if (!acct) addIssue([where, i, "accounts"], `unknown account '${id}'`);
        else if (acct.provider !== entry.provider) addIssue([where, i, "accounts"], `account '${id}' is a ${acct.provider} account, not ${entry.provider}`);
      }
    });
  }
}

const ChainSchema = z.array(ProviderEntrySchema).min(1, "a chain needs at least one provider");

/** Roles whose Attempts write code in a clone: the reviewer-independence rule covers all of them. */
export const WRITER_ROLES = ["implement", "revise", "rebase"] as const;
export type WriterRole = (typeof WRITER_ROLES)[number];

/**
 * One provider chain per role, so menial work can run on cheaper models than the first implementation.
 * `triage` is reserved for escalation triage and is only validated today.
 */
export const ChainsSchema = z
  .object({
    implement: ChainSchema.default([{ provider: "codex" }, { provider: "agy" }]),
    revise: ChainSchema.default([{ provider: "codex" }, { provider: "agy" }]),
    rebase: ChainSchema.default([{ provider: "codex" }, { provider: "agy" }]),
    scout: ChainSchema.default([{ provider: "claude" }, { provider: "codex" }]),
    triage: ChainSchema.default([{ provider: "claude" }, { provider: "codex" }]),
  })
  .strict()
  .superRefine((c, ctx) => {
    // Scouts run read-only and only claude and codex have a verified read-only mode.
    if (!c.scout.some((e) => e.provider === "claude" || e.provider === "codex")) {
      ctx.addIssue({ code: "custom", path: ["scout"], message: "the scout chain needs a claude or codex entry (agy has no verified read-only mode)" });
    }
  });
export type Chains = z.infer<typeof ChainsSchema>;

/** The vendor each writing role tries first: who wrote the code when no Attempt has recorded a vendor yet. */
export function primaryWriterVendors(chains: Pick<Chains, WriterRole>): ReviewerVendor[] {
  return [...new Set(WRITER_ROLES.map((r) => providerToVendor(chains[r][0]!.provider)))];
}

/** Every vendor that can write code for a Thread, across implement, revise and rebase. */
export function writerVendors(chains: Pick<Chains, WriterRole>): ReviewerVendor[] {
  return [...new Set(WRITER_ROLES.flatMap((r) => chains[r].map((e) => providerToVendor(e.provider))))];
}

export const AuthModeSchema = z.enum(["subscription", "api"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export function providerToVendor(provider: CliProvider): ReviewerVendor {
  if (provider === "codex") return "openai";
  if (provider === "agy") return "gemini";
  return "anthropic";
}

/** `owner/name` as GitHub allows it. No spaces or URL metacharacters (slugs are interpolated into REST paths), and the name is never `.` or `..`. */
export const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

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
  /** Opt-in: glob (relative to the repo) of the JUnit XML the test command writes; enables test-ID diffing in the Gate. */
  junitReport: z.string().min(1).optional(),
  baseTestRuns: z.number().int().min(1).default(3),
  headTestRuns: z.number().int().min(1).default(2),
});

export type GatePolicy = z.infer<typeof GatePolicySchema>;

/** Repo-owned Archangel policy file, always read from the default branch / base commit. */
export const REPO_POLICY_PATH = ".agents/archangel.json";

export const LabelsSchema = z.object({
  readyForAgent: z.string().default("ready-for-agent"),
  paused: z.string().default("factory:paused"),
  stop: z.string().default("factory:stop"),
  needsYou: z.string().default("needs-you"),
  disagree: z.string().default("factory:disagree"),
  agentProposed: z.string().default("agent-proposed"),
  /** Label on pitch issues (never `agent-proposed`, so a pitch can never be auto-promoted or counted as a bug proposal). */
  agentPitch: z.string().default("agent-pitch"),
  /** Owner-applied label that makes a Thread a feature (owner merges; no red-on-base proof). */
  feature: z.string().default("class:feature"),
  /** Owner-applied label that makes a Thread a chore (cleanup/hygiene; owner merges; no red-on-base proof). */
  chore: z.string().default("class:chore"),
});

export const ScoutsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxRunsPerDay: z.number().int().min(1).max(10).default(2),
  maxOpenProposals: z.number().int().min(1).max(10).default(3),
  /** Hard host cap on Scout proposals promoted without the owner (only for Scouts with `autoPromote: true`). */
  maxAutoPromotionsPerDay: z.number().int().min(0).max(5).default(1),
});

export type ScoutsConfig = z.infer<typeof ScoutsConfigSchema>;

/** Per-thread attempt/step limits: host-level defaults, overridable per project. */
const AttemptLimitFields = {
  /** Autonomous steps (Attempt starts + auto-merges) allowed before the owner is next heard from. */
  maxAutonomousStepsWithoutOwner: z.number().int().min(1).default(25),
  maxImplementAttemptsPerThread: z.number().int().min(1).default(3),
  maxRevisionsPerThread: z.number().int().min(0).default(1),
  maxRebasesPerThread: z.number().int().min(0).default(1),
};

/** Host-level execution timeouts and liveness windows. */
const TimeoutFields = {
  implementMaxTurns: z.number().int().min(1).default(40),
  implementTimeoutMs: z.number().int().min(30_000).default(20 * 60_000),
  setupTimeoutMs: z.number().int().min(5_000).default(5 * 60_000),
  staleLeaseMs: z.number().int().min(10_000).default(3 * 60_000),
  gateStartGraceMs: z.number().int().min(10_000).default(5 * 60_000),
  gateTimeoutMs: z.number().int().min(60_000).default(60 * 60_000),
  reviewerOutageMaxMs: z.number().int().min(60_000).default(6 * 60 * 60_000),
};

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
  /** Local hour (0-23, in dailyTimezone) at or after which the once-a-day digest is sent. */
  digestHour: z.number().int().min(0).max(23).default(9),
  maxAutoMergesPerDay: z.number().int().min(1).default(3),
  shadowMode: z.boolean().default(true),
  /** Host kill switch: false stops factory retries on every repo, whatever its workflow file says. */
  factoryRetry: z.boolean().default(true),
  /** Bundled fleet Scouts enabled on this machine; they run on every project unless its workflow file opts out. */
  fleetScouts: z.array(z.enum(FLEET_SCOUT_NAMES)).default([]),
  ...AttemptLimitFields,
  ...TimeoutFields,

  /** Fixed constants: label names are not configurable. */
  labels: LabelsSchema.default({
    readyForAgent: "ready-for-agent",
    paused: "factory:paused",
    stop: "factory:stop",
    needsYou: "needs-you",
    disagree: "factory:disagree",
    agentProposed: "agent-proposed",
    agentPitch: "agent-pitch",
    feature: "class:feature",
    chore: "class:chore",
  }),
  scouts: ScoutsConfigSchema.default({
    enabled: false,
    maxRunsPerDay: 2,
    maxOpenProposals: 3,
    maxAutoPromotionsPerDay: 1,
  }),

  // Models, auth mode (native CLI subscriptions vs metered API keys), & optional notifications/handoff
  authMode: AuthModeSchema.default("api"),
  chains: ChainsSchema.default(ChainsSchema.parse({})),
  accounts: z.array(AccountSchema).default(DEFAULT_ACCOUNTS),
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
  if (Boolean(cfg.telegramBotToken) !== Boolean(cfg.telegramChatId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [cfg.telegramBotToken ? "telegramChatId" : "telegramBotToken"],
      message: "Telegram needs both ARCHANGEL_TELEGRAM_BOT_TOKEN and ARCHANGEL_TELEGRAM_CHAT_ID (or neither): with one, every alert is silently dropped",
    });
  }
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

const ProjectAttemptOverrides = {
  maxAutonomousStepsWithoutOwner: z.number().int().min(1).optional(),
  maxImplementAttemptsPerThread: z.number().int().min(1).optional(),
  maxRevisionsPerThread: z.number().int().min(0).optional(),
  maxRebasesPerThread: z.number().int().min(0).optional(),
};

const HostProjectYamlSchema = z.object({
  repo: z.string().regex(REPO_SLUG_RE, "repo must be 'owner/name' (letters, digits, '-', '_', '.')"),
  defaultBranch: z.string().min(1).default("main"),
  workspace: z.enum(["local-clone"]).default("local-clone"),
  githubInstallationId: z.number().int().positive().optional(),
  shadowMode: z.boolean().default(true),
  maxConcurrentThreads: z.number().int().min(1).max(3).default(2),
  maxAutoMergesPerDay: z.number().int().min(1).default(3),
  ...ProjectAttemptOverrides,
  scouts: ScoutsConfigSchema.default({
    enabled: false,
    maxRunsPerDay: 2,
    maxOpenProposals: 3,
    maxAutoPromotionsPerDay: 1,
  }),
}).strict();

export const HostYamlSchema = z.object({
  ownerUserId: z.number().int().positive(),
  dataDir: z.string().min(1).default(".archangel"),
  pollIntervalMs: z.number().int().min(5000).default(30_000),
  maxDailyUsd: z.number().positive().default(20),
  dailyTimezone: z.string().min(1).default("America/New_York"),
  /** Local hour (0-23, in dailyTimezone) at or after which the once-a-day digest is sent. */
  digestHour: z.number().int().min(0).max(23).default(9),
  factoryRetry: z.boolean().default(true),
  /** Bundled fleet Scouts enabled on this machine; they run on every project unless its workflow file opts out. */
  fleetScouts: z.array(z.enum(FLEET_SCOUT_NAMES)).default([]),
  ...AttemptLimitFields,
  ...TimeoutFields,
  authMode: AuthModeSchema.default("subscription"),
  chains: ChainsSchema.default(ChainsSchema.parse({})),
  accounts: z.array(AccountSchema).default(DEFAULT_ACCOUNTS),
  reviewerChain: z
    .array(ProviderEntrySchema)
    .min(2)
    .default([{ provider: "agy" }, { provider: "claude" }, { provider: "codex" }]),
  claudeModel: z.string().default("claude-sonnet-4-6"),
  openaiReviewerModel: z.string().default("gpt-5.4"),
  geminiReviewerModel: z.string().default("gemini-2.5-pro"),
  paseoHost: z.string().optional(),
  paseoHome: z.string().optional(),
  projects: z.array(HostProjectYamlSchema).min(1),
}).strict().superRefine((host, ctx) => {
  checkAccounts(
    host.accounts,
    [...Object.entries(host.chains).map(([role, chain]) => [`chains.${role}`, chain] as [string, ProviderEntry[]]), ["reviewerChain", host.reviewerChain]],
    (p, message) => ctx.addIssue({ code: "custom", path: p, message }),
  );
  // Two entries for one repo would run two Reconcilers over one Broker clone, clones dir and Ledger view.
  const seen = new Set<string>();
  host.projects.forEach((p, i) => {
    const key = p.repo.toLowerCase();
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["projects", i, "repo"], message: `duplicate project '${p.repo}' (repo names are case-insensitive)` });
    seen.add(key);
  });
});

/**
 * Resolves the 2 independent reviewer vendors required for a project (ADR-0003: implementer != reviewer).
 */
export function resolveRequiredReviewers(
  cfg: Pick<ArchangelConfig, "authMode" | "chains" | "reviewerChain">,
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
      : primaryWriterVendors(cfg.chains),
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

/** The host config path the daemon reads: the explicit option, else `ARCHANGEL_CONFIG`, else `./archangel.yaml`. */
export function resolveConfigPath(configPath?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(configPath ?? env.ARCHANGEL_CONFIG ?? "archangel.yaml");
}

/**
 * Loads multi-project host config from `archangel.yaml` merged with secrets strictly from `env`.
 * A missing file is an error: there is no environment-only configuration.
 */
export function loadProjectConfigs(opts: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ArchangelConfig[] {
  const env = opts.env ?? process.env;
  const resolvedConfig = resolveConfigPath(opts.configPath, env);

  if (!fs.existsSync(resolvedConfig)) {
    throw new Error(`Host config not found: ${resolvedConfig} (copy archangel.example.yaml to archangel.yaml)`);
  }
  const rawText = fs.readFileSync(resolvedConfig, "utf8");
  const yamlObj = parseYaml(rawText);
  const host = HostYamlSchema.parse(yamlObj);
  const homeProblems = accountHomeProblems(host.accounts);
  if (homeProblems.length > 0) {
    throw new Error(`Invalid accounts in ${resolvedConfig}: ${homeProblems.map((p) => `${p.id}: ${p.problem}`).join("; ")}`);
  }

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
      digestHour: host.digestHour,
      maxConcurrentThreads: proj.maxConcurrentThreads,
      maxAutoMergesPerDay: proj.maxAutoMergesPerDay,
      maxAutonomousStepsWithoutOwner: proj.maxAutonomousStepsWithoutOwner ?? host.maxAutonomousStepsWithoutOwner,
      maxImplementAttemptsPerThread: proj.maxImplementAttemptsPerThread ?? host.maxImplementAttemptsPerThread,
      maxRevisionsPerThread: proj.maxRevisionsPerThread ?? host.maxRevisionsPerThread,
      maxRebasesPerThread: proj.maxRebasesPerThread ?? host.maxRebasesPerThread,
      implementMaxTurns: host.implementMaxTurns,
      implementTimeoutMs: host.implementTimeoutMs,
      setupTimeoutMs: host.setupTimeoutMs,
      staleLeaseMs: host.staleLeaseMs,
      gateStartGraceMs: host.gateStartGraceMs,
      gateTimeoutMs: host.gateTimeoutMs,
      reviewerOutageMaxMs: host.reviewerOutageMaxMs,
      shadowMode: proj.shadowMode,
      factoryRetry: host.factoryRetry,
      fleetScouts: host.fleetScouts,
      scouts: proj.scouts,
      authMode: host.authMode,
      chains: host.chains,
      accounts: host.accounts,
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
