import path from "node:path";
import type { Command } from "commander";
import { loadProjectConfigs, primaryWriterVendors, resolvePaths, resolveUserPath, type ArchangelConfig } from "../config.js";
import type { ReviewerSuite } from "../agents/reviewers.js";
import { pruneTranscripts, SubscriptionImplementer, TRANSCRIPT_RETENTION_MS } from "../agents/subscription-implementer.js";
import { SubscriptionReviewerSuite } from "../agents/subscription-reviewers.js";
import { GitBroker } from "../broker/git-broker.js";
import { SHUTDOWN_DEADLINE_MS, settleWithin } from "../core/shutdown.js";
import { ArchangelLogger, errorLine } from "../core/logger.js";
import { sendDigestIfDue } from "../core/digest.js";
import { runEval } from "../core/eval.js";
import { prepareCandidates } from "../core/eval-candidate.js";
import { ARCHANGEL_ROOT, execRunner } from "../core/onboard.js";
import { Reconciler } from "../core/reconciler.js";
import { TelegramNotifier } from "../core/notifier.js";
import { recordDaemonFacts } from "../core/host-facts.js";
import { defaultScoutCliInvoker } from "../core/scout.js";
import { ARCHANGEL_REPO, ghPrStatus, openDraftPr } from "../core/correction-draft.js";
import { LocalProvider } from "../compute/local.js";
import { createSailProvider, remoteAttemptProvider, remoteProviders } from "../compute/sail-sdk.js";
import { Secret } from "@sailresearch/sdk";
import { AGY_BROKER_ID, agyBrokerAdapter } from "../compute/agy-broker-adapter.js";
import { CODEX_BROKER_ID, codexBrokerAdapter } from "../compute/codex-broker-adapter.js";
import { TokenBroker, brokerPreflight } from "../compute/token-broker.js";
import type { SailProvider } from "../compute/sail.js";
import { SandboxExecProvider, stopAllPreviews, sweepOrphanPreviews } from "../compute/sandbox-exec.js";
import { listAllSkills } from "../core/skills.js";
import { GitHubAppClient } from "../github/client.js";
import { Ledger } from "../ledger/store.js";
import { emit, setTelemetrySink, TELEMETRY_PRUNE_BATCH, TELEMETRY_RETENTION_MS } from "../core/telemetry.js";
import { evalSources, makeReviewerSuite } from "./shared.js";

/** What every project's wiring shares: the daemon's identity, its one root Ledger, and the host-level clients. */
interface DaemonDeps {
  logger: ArchangelLogger;
  rootLedger: Ledger;
  daemonOwnerId: string;
  /** The first project: the host settings (data dir, poll interval, digest hour, reviewers) come from it. */
  first: ArchangelConfig;
  dataDir: string;
  reviewers: ReviewerSuite;
  notifier: TelegramNotifier;
  accountState: ReturnType<Ledger["accountState"]>;
}

/** Everything the tick loop and shutdown act on, plus the loop's mutable state. */
interface Run extends DaemonDeps {
  once: boolean;
  lockHeartbeat: NodeJS.Timeout;
  brokers: TokenBroker[];
  reconcilers: Array<{ repoSlug: string; rec: Reconciler }>;
  sailProviders: SailProvider[];
  digestSources: Array<{ repoSlug: string; github: GitHubAppClient; agentProposedLabel: string }>;
  transcriptDirs: string[];
  stopping: boolean;
  nextTimer: NodeJS.Timeout | null;
  inFlightTick: Promise<void> | null;
  cleanupDone: Promise<boolean> | null;
  lastTranscriptPrune: number;
}

/** What building the projects collects besides their Reconcilers. */
interface ProjectSinks {
  /** Each watched repo's App client and Broker, so the correction loop can open a draft PR as the App on Archangel's own repo. */
  appClients: Map<string, { github: GitHubAppClient; broker: GitBroker; defaultBranch: string }>;
  digestSources: Run["digestSources"];
  sailProviders: SailProvider[];
}

/** One broker per dedicated login: it alone refreshes that login and puts only the access token in a Sail secret. */
function createTokenBrokers(projects: ArchangelConfig[], dataDir: string, logger: ArchangelLogger): TokenBroker[] {
  const brokerHomes = new Set(projects.flatMap((cfg) => (cfg.compute.provider === "sail" && cfg.compute.sail?.codexBrokerHome ? [resolveUserPath(cfg.compute.sail.codexBrokerHome)] : [])));
  const agyBrokerHomes = new Set(projects.flatMap((cfg) => (cfg.compute.provider === "sail" && cfg.compute.sail?.agyBrokerHome ? [resolveUserPath(cfg.compute.sail.agyBrokerHome)] : [])));
  return [...[...brokerHomes].map((home) => codexBrokerAdapter(home)), ...[...agyBrokerHomes].map((home) => agyBrokerAdapter(home))].map(
    (adapter) => new TokenBroker(adapter, dataDir, (name, value) => Secret.set(name, value), (m) => logger.error("broker/token", m)),
  );
}

/** One project's wiring: App client, Broker, compute, implementer and Reconciler (swept for Threads the last run left working). */
function buildProject(cfg: ArchangelConfig, d: DaemonDeps, sinks: ProjectSinks): { repoSlug: string; rec: Reconciler } {
  const { logger, rootLedger, first } = d;
  const repoSlug = `${cfg.githubOwner}/${cfg.githubRepo}`;
  const paths = resolvePaths(cfg);
  const github = new GitHubAppClient({
    owner: cfg.githubOwner,
    repo: cfg.githubRepo,
    appId: cfg.githubAppId,
    installationId: cfg.githubInstallationId,
    privateKeyPem: cfg.githubPrivateKeyPem,
  });
  const broker = new GitBroker({
    bareRepoPath: paths.brokerBareRepoPath,
    clonesDir: paths.clonesDir,
    defaultBranch: cfg.defaultBranch,
    repo: repoSlug,
    enableLocalGate: true,
    // H1: run diff/path/immutability/pre-commit locally; let ephemeral CI VM execute untrusted agent test binaries.
    localGateSkipTests: true,
  });
  const scoutCompute: SailProvider | undefined =
    cfg.compute.provider === "sail" && cfg.compute.sail
      ? createSailProvider({ sail: cfg.compute.sail, broker, dataDir: paths.dataDir, repoSlug })
      : undefined;
  if (scoutCompute) sinks.sailProviders.push(scoutCompute);
  const implementer = new SubscriptionImplementer({
    chains: cfg.chains,
    accounts: cfg.accounts,
    remoteProviders: remoteProviders(cfg.compute),
    codexBrokerPreflight: cfg.compute.sail?.codexBrokerHome
      ? (attemptMs) => ({ accountId: brokerPreflight(d.dataDir, CODEX_BROKER_ID, attemptMs).accountId! })
      : undefined,
    agyBrokerPreflight: cfg.compute.sail?.agyBrokerHome ? (attemptMs) => void brokerPreflight(d.dataDir, AGY_BROKER_ID, attemptMs) : undefined,
    transcriptsDir: paths.transcriptsDir,
    accountState: d.accountState,
    logger,
  });
  const rec = new Reconciler({
    config: cfg,
    ledger: rootLedger.forRepo(repoSlug),
    github,
    broker,
    implementer,
    reviewers: d.reviewers,
    notifier: d.notifier,
    logger,
    workerId: d.daemonOwnerId,
    scoutCompute,
    remoteAttemptCompute: remoteAttemptProvider(cfg, scoutCompute),
    previewCompute: new SandboxExecProvider(new LocalProvider(broker), { reservedPorts: [cfg.ui.port] }),
    correctionDrafts: {
      invoker: defaultScoutCliInvoker,
      cwd: ARCHANGEL_ROOT,
      skills: listAllSkills(),
      evaluate: async (patchFile, heldout) => {
        const { baseline, candidate } = await prepareCandidates(ARCHANGEL_ROOT, patchFile);
        try {
          return await runEval({
            ledger: rootLedger,
            sources: evalSources(rootLedger, d.dataDir),
            suiteFor: (prompts) => new SubscriptionReviewerSuite({ chain: first.reviewerChain, defaultExcludeVendors: primaryWriterVendors(first.chains), timeoutMs: first.reviewTimeoutMs, prompts }),
            baseline: baseline.prompts,
            candidate,
            heldout,
          });
        } finally {
          candidate.cleanup();
        }
      },
      openPr: (draft, body, ctx) => {
        const client = sinks.appClients.get(ARCHANGEL_REPO);
        if (!client) throw new Error(`${ARCHANGEL_REPO} is not a watched project, so there is no App client to open the draft PR with`);
        return openDraftPr(client, draft, body, ctx);
      },
      prStatus: (url) => ghPrStatus(execRunner, url),
    },
  });
  const swept = rec.startupSweep();
  if (swept.length > 0) logger.info("daemon/stale_working_recovered", `Recovered Threads left working by the last run: ${swept.join(", ")}`, { repo: repoSlug, data: { issues: swept } });
  sinks.digestSources.push({ repoSlug, github, agentProposedLabel: cfg.labels.agentProposed });
  sinks.appClients.set(repoSlug, { github, broker, defaultBranch: cfg.defaultBranch });
  return { repoSlug, rec };
}

function runTick(run: Run): Promise<void> {
  run.inFlightTick = runTickBody(run).finally(() => {
    run.inFlightTick = null;
  });
  return run.inFlightTick;
}

/** A step that failed and was survived: one line, and for a repo's tick a health fact (shown on the dashboard, and a Needs you once it repeats). */
function survived(run: Run, step: string, err: unknown, repo?: string): void {
  run.logger.error(`daemon/${step}_error`, errorLine(err), repo ? { repo } : undefined);
  if (repo) run.rootLedger.recordHealthFault(step, errorLine(err), Date.now(), repo);
}

async function runTickBody(run: Run): Promise<void> {
  const { logger, rootLedger, first } = run;
  try {
    const swept = await sweepOrphanPreviews();
    if (swept.length > 0) logger.info("preview/orphans_killed", `Killed orphan preview(s): ${swept.join(", ")}`);
  } catch (err) {
    survived(run, "preview_sweep", err);
  }
  for (const sail of run.sailProviders) {
    try {
      const swept = await sail.sweepOrphans();
      if (swept.length > 0) logger.info("sail/orphans_terminated", `Terminated orphan Sail box(es): ${swept.join(", ")}`);
    } catch (err) {
      survived(run, "sail_sweep", err);
    }
  }
  for (const { repoSlug, rec } of run.reconcilers) {
    if (run.stopping) break;
    try {
      const t0 = Date.now();
      await rec.tick(t0, { waitForAttempts: run.once });
      // With --once the tick also waits for Attempts, which is not tick time.
      if (!run.once) emit("tick_ms", Date.now() - t0, {}, repoSlug);
    } catch (err) {
      survived(run, "tick", err, repoSlug);
    }
  }
  if (Date.now() - run.lastTranscriptPrune >= 3_600_000) {
    run.lastTranscriptPrune = Date.now();
    for (const dir of run.transcriptDirs) {
      try {
        const n = pruneTranscripts(dir, Date.now() - TRANSCRIPT_RETENTION_MS);
        if (n > 0) logger.info("daemon/transcripts_pruned", `Pruned ${n} old transcript file(s) in ${dir}`);
      } catch (err) {
        survived(run, "transcript_prune", err);
      }
    }
  }
  try {
    rootLedger.pruneTelemetry(Date.now() - TELEMETRY_RETENTION_MS, TELEMETRY_PRUNE_BATCH);
  } catch (err) {
    survived(run, "telemetry_prune", err);
  }
  try {
    await sendDigestIfDue(rootLedger, run.notifier, {
      now: Date.now(),
      timeZone: first.dailyTimezone,
      digestHour: first.digestHour,
      openProposals: async () => {
        const open = new Set<string>();
        for (const { repoSlug, github, agentProposedLabel } of run.digestSources) {
          for (const issue of await github.listOpenIssuesByLabel(agentProposedLabel)) open.add(`${repoSlug}#${issue.number}`);
        }
        return open;
      },
    });
  } catch (err) {
    survived(run, "digest", err);
  }
}

// Idempotent (a second signal joins the first). Waits for in-flight work only up to the deadline, then releases the
// Ledger lock regardless: a wedged Attempt must not hold the lock forever. Resolves false when the deadline passed.
function cleanup(run: Run, why: string): Promise<boolean> {
  const { logger, rootLedger } = run;
  run.cleanupDone ??= (async () => {
    run.stopping = true;
    const inFlight = run.reconcilers.reduce((n, { rec }) => n + rec.activeTaskCount(), 0);
    logger.info("daemon/stopping", `Stopping (${why}); ${inFlight} Attempt(s) in flight are aborted and resume on the next start`, { data: { why, inFlight } });
    if (run.nextTimer) clearTimeout(run.nextTimer);
    clearInterval(run.lockHeartbeat);
    stopAllPreviews();
    for (const b of run.brokers) b.stop();
    for (const { rec } of run.reconcilers) rec.abortAllActive("control");
    const settled = await settleWithin(
      Promise.all([...run.reconcilers.map(({ rec }) => rec.waitForActiveTasks()), run.inFlightTick]),
      SHUTDOWN_DEADLINE_MS,
    );
    if (settled) logger.info("daemon/stopped", "Stopped cleanly; Ledger lock released", { data: { why, settled } });
    else logger.error("daemon/stopped", `Shutdown deadline (${SHUTDOWN_DEADLINE_MS} ms) passed with work in flight; releasing the Ledger lock and exiting`, { data: { why, settled } });
    setTelemetrySink(null);
    rootLedger.releaseDaemonLock(run.daemonOwnerId);
    if (settled) rootLedger.close();
    return settled;
  })();
  return run.cleanupDone;
}

function scheduleNext(run: Run): void {
  if (run.stopping) return;
  run.nextTimer = setTimeout(async () => {
    await runTick(run);
    scheduleNext(run);
  }, run.first.pollIntervalMs);
}

function exitAfterCleanup(run: Run, signal: string): void {
  void cleanup(run, signal).then((settled) => process.exit(settled ? 0 : 1));
}

export function registerStart(program: Command): void {
  program
    .command("start")
    .description("Start the level-triggered Archangel reconciler daemon")
    .option("-c, --config <path>", "Path to archangel.yaml")
    .option("--once", "Run a single reconciliation tick across all configured projects and exit")
    .action(async (opts: { config?: string; once?: boolean }) => {
      const projects = loadProjectConfigs({ configPath: opts.config });
      const first = projects[0]!;
      const sharedPaths = resolvePaths(first);
      const daemonOwnerId = `daemon-${process.pid}-${Date.now()}`;

      if (!opts.once && process.stdout.isTTY) {
        console.log(
          "[archangel] Tip: run under `caffeinate -i archangel start` on macOS laptops to avoid sleep mid-Attempt.",
        );
      }
      const logger = new ArchangelLogger({
        logFilePath: path.join(sharedPaths.dataDir, "archangel.log.jsonl"),
        consoleOutput: true,
      });

      const rootLedger = new Ledger(sharedPaths.ledgerDbPath, { timeZone: first.dailyTimezone });

      // Single daemon lock prevents `start` and `start --once` from colliding or sweeping live work (Opus R9 / Codex #6).
      if (!rootLedger.acquireDaemonLock(daemonOwnerId, first.staleLeaseMs)) {
        rootLedger.close();
        throw new Error("Another live Archangel daemon already holds the Ledger lock.");
      }

      recordDaemonFacts(rootLedger, { configPath: opts.config });
      setTelemetrySink(rootLedger);
      emit("daemon_start", 1, {});

      // Lost lock (laptop slept past staleLeaseMs and another daemon took over): stop now, loudly, rather than tick as a second daemon.
      // `run` is assigned below, long before the first beat (30 s).
      let run!: Run;
      const lockHeartbeat = setInterval(() => {
        if (rootLedger.heartbeatDaemonLock(daemonOwnerId)) return;
        logger.error("daemon/lock_lost", "Lost the Ledger daemon lock to another process; shutting down.");
        void cleanup(run, "lock_lost").finally(() => process.exit(1));
      }, 30_000);

      const reviewers = makeReviewerSuite(first, rootLedger);
      const notifier = new TelegramNotifier({
        botToken: first.telegramBotToken,
        chatId: first.telegramChatId,
      });
      const accountState = rootLedger.accountState(first.accounts);

      const chain = (entries: Array<{ provider: string }>) => entries.map((e) => e.provider).join("->");
      logger.info(
        "daemon/started",
        `Started (pid ${process.pid}) on ${projects.map((p) => `${p.githubOwner}/${p.githubRepo}`).join(", ")}; subscription CLIs (impl=${chain(first.chains.implement)}, revise=${chain(first.chains.revise)}, rebase=${chain(first.chains.rebase)}, scout=${chain(first.chains.scout)}, reviewers=${chain(first.reviewerChain)})`,
        { data: { pid: process.pid, repos: projects.map((p) => `${p.githubOwner}/${p.githubRepo}`), once: Boolean(opts.once) } },
      );

      const deps: DaemonDeps = { logger, rootLedger, daemonOwnerId, first, dataDir: sharedPaths.dataDir, reviewers, notifier, accountState };
      const sinks: ProjectSinks = { appClients: new Map(), digestSources: [], sailProviders: [] };
      const brokers = createTokenBrokers(projects, sharedPaths.dataDir, logger);
      await Promise.all(brokers.map((b) => b.start()));
      const transcriptDirs = projects.map((cfg) => resolvePaths(cfg).transcriptsDir);
      const reconcilers = projects.map((cfg) => buildProject(cfg, deps, sinks));

      run = {
        ...deps,
        once: Boolean(opts.once),
        lockHeartbeat,
        brokers,
        reconcilers,
        sailProviders: sinks.sailProviders,
        digestSources: sinks.digestSources,
        transcriptDirs,
        stopping: false,
        nextTimer: null,
        inFlightTick: null,
        cleanupDone: null,
        lastTranscriptPrune: 0,
      };

      if (opts.once) {
        try {
          await runTick(run);
        } finally {
          await cleanup(run, "once");
        }
        return;
      }

      process.on("SIGINT", () => exitAfterCleanup(run, "SIGINT"));
      process.on("SIGTERM", () => exitAfterCleanup(run, "SIGTERM"));

      await runTick(run);
      scheduleNext(run);
    });
}
