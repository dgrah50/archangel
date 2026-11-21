#!/usr/bin/env node
import { Command } from "commander";
import { loadConfigFromEnv, resolvePaths } from "../config.js";
import { ClaudeSdkImplementer } from "../agents/implementer.js";
import { MastraReviewerSuite } from "../agents/reviewers.js";
import { GitBroker } from "../broker/git-broker.js";
import { TelegramNotifier } from "../core/notifier.js";
import { Reconciler } from "../core/reconciler.js";
import { GitHubAppClient } from "../github/client.js";
import { handoffThreadToPaseo, PaseoCliRunner, resumeThreadFromPaseo } from "../handoff/paseo.js";
import { Ledger } from "../ledger/store.js";

const program = new Command();

program
  .name("archangel")
  .description("Archangel autonomous software factory CLI")
  .version("0.1.0");

program
  .command("start")
  .description("Start the level-triggered Archangel reconciler daemon")
  .option("--once", "Run a single reconciliation tick and exit")
  .action(async (opts: { once?: boolean }) => {
    const cfg = loadConfigFromEnv();
    const paths = resolvePaths(cfg);

    if (!cfg.workerOsUser) {
      console.warn(
        "[archangel] WARNING: ARCHANGEL_WORKER_USER is unset — OS-level implementer credential isolation is advisory in local dev mode (see ADR-0004).",
      );
    }
    if (!opts.once) {
      console.log(
        "[archangel] Tip: run under `caffeinate -i archangel start` on macOS laptops to avoid sleep mid-Attempt.",
      );
    }

    const ledger = new Ledger(paths.ledgerDbPath, { timeZone: cfg.dailyTimezone });
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
    });

    if (!cfg.anthropicApiKey || !cfg.openaiApiKey || !cfg.googleApiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY, OPENAI_API_KEY, and GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) are required.",
      );
    }

    const implementer = new ClaudeSdkImplementer({
      apiKey: cfg.anthropicApiKey,
      model: cfg.claudeModel,
      transcriptsDir: paths.transcriptsDir,
      workerOsUser: cfg.workerOsUser,
    });
    const reviewers = new MastraReviewerSuite({
      openaiApiKey: cfg.openaiApiKey,
      googleApiKey: cfg.googleApiKey,
      openaiModel: cfg.openaiReviewerModel,
      geminiModel: cfg.geminiReviewerModel,
      mastraDbPath: paths.mastraDbPath,
    });
    const notifier = new TelegramNotifier({
      botToken: cfg.telegramBotToken,
      chatId: cfg.telegramChatId,
    });

    const reconciler = new Reconciler({
      config: cfg,
      ledger,
      github,
      broker,
      implementer,
      reviewers,
      notifier,
    });

    const swept = reconciler.startupSweep();
    if (swept.length > 0) {
      console.log(`[archangel] Startup stale-run sweep recovered threads: ${swept.join(", ")}`);
    }

    const runTick = async () => {
      try {
        await reconciler.tick();
      } catch (err) {
        console.error("[archangel] Tick error:", err);
      }
    };

    await runTick();
    if (opts.once) {
      ledger.close();
      return;
    }

    const timer = setInterval(runTick, cfg.pollIntervalMs);
    const shutdown = () => {
      clearInterval(timer);
      ledger.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("status")
  .description("Show Threads, Needs You queue, spend, merges, and Shadow Mode agreement")
  .option("--data-dir <dir>", "Archangel data directory", process.env.ARCHANGEL_DATA_DIR ?? ".archangel")
  .option("--json", "Output JSON")
  .action((opts: { dataDir: string; json?: boolean }) => {
    const paths = resolvePaths({ dataDir: opts.dataDir });
    const ledger = new Ledger(paths.ledgerDbPath, { readonly: true });
    try {
      const threads = ledger.listThreads();
      const shadow = ledger.getShadowStats();
      const breaker = ledger.getCircuitBreaker();
      const spendToday = ledger.getSpendToday();
      const autoMergesToday = ledger.getAutoMergeCountToday();

      const payload = {
        spendTodayUsd: Number(spendToday.toFixed(4)),
        autoMergesToday,
        circuitBreaker: breaker,
        shadowModeStats: shadow,
        needsYou: threads.filter((t) => t.state === "needs_you"),
        threads,
      };

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(`Spend today:      $${payload.spendTodayUsd.toFixed(2)}`);
      console.log(`Auto-merges:      ${autoMergesToday}`);
      console.log(`Circuit breaker:  ${breaker.tripped ? `TRIPPED (${breaker.reason})` : "closed"}`);
      console.log(
        `Shadow agreement: ${shadow.agreed}/${shadow.total} (${Math.round(shadow.agreementRate * 100)}%)`,
      );
      console.log("");
      if (threads.length === 0) {
        console.log("No threads recorded in Ledger yet.");
        return;
      }
      for (const t of threads) {
        const pr = t.prNumber ? `PR #${t.prNumber}` : "no PR";
        const note = t.needsYouReason ? ` — ${t.needsYouReason}` : "";
        console.log(`#${t.issueNumber}  [${t.state}]  ${pr}  ${t.title}${note}`);
      }
    } finally {
      ledger.close();
    }
  });

program
  .command("events")
  .description("Inspect the append-only Ledger audit log")
  .option("--data-dir <dir>", "Archangel data directory", process.env.ARCHANGEL_DATA_DIR ?? ".archangel")
  .option("--topic <prefix>", "Filter by topic prefix")
  .option("--issue <number>", "Filter by issue number")
  .option("--limit <n>", "Max entries", "40")
  .action((opts: { dataDir: string; topic?: string; issue?: string; limit: string }) => {
    const paths = resolvePaths({ dataDir: opts.dataDir });
    const ledger = new Ledger(paths.ledgerDbPath, { readonly: true });
    try {
      const entries = ledger.listAudit({
        topicPrefix: opts.topic,
        issueNumber: opts.issue ? Number(opts.issue) : undefined,
        limit: Number(opts.limit),
      });
      for (const e of entries.reverse()) {
        const ts = new Date(e.ts).toISOString();
        const issueStr = e.issueNumber ? `#${e.issueNumber}` : "-";
        console.log(`${ts}  ${e.topic}  ${issueStr}  (${e.actor})  ${e.payloadJson}`);
      }
    } finally {
      ledger.close();
    }
  });

program
  .command("handoff <issue>")
  .description("Pause factory autonomy and hand off a Thread to Paseo")
  .option("--repo-dir <dir>", "Local repo path for Paseo worktree creation")
  .action(async (issueArg: string, opts: { repoDir?: string }) => {
    const cfg = loadConfigFromEnv();
    const paths = resolvePaths(cfg);
    const ledger = new Ledger(paths.ledgerDbPath, { timeZone: cfg.dailyTimezone });
    try {
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
      });
      const paseo = new PaseoCliRunner({ host: cfg.paseoHost, home: cfg.paseoHome });
      const res = await handoffThreadToPaseo(Number(issueArg), {
        config: cfg,
        ledger,
        github,
        broker,
        paseo,
        localRepoDir: opts.repoDir,
      });
      console.log(
        `Handed off #${issueArg} on ${res.branchName} to Paseo (agent=${res.agentId}, workspace=${res.workspaceId ?? "n/a"})`,
      );
    } finally {
      ledger.close();
    }
  });

program
  .command("resume <issue>")
  .description("Resume advisory Gate & Review tracking after Paseo Handoff (owner merges manually)")
  .action(async (issueArg: string) => {
    const cfg = loadConfigFromEnv();
    const paths = resolvePaths(cfg);
    const ledger = new Ledger(paths.ledgerDbPath, { timeZone: cfg.dailyTimezone });
    try {
      const github = new GitHubAppClient({
        owner: cfg.githubOwner,
        repo: cfg.githubRepo,
        appId: cfg.githubAppId,
        installationId: cfg.githubInstallationId,
        privateKeyPem: cfg.githubPrivateKeyPem,
      });
      const paseo = new PaseoCliRunner({ host: cfg.paseoHost, home: cfg.paseoHome });
      const res = await resumeThreadFromPaseo(Number(issueArg), {
        config: cfg,
        ledger,
        github,
        paseo,
      });
      console.log(`Resumed #${issueArg} at owner-authorized SHA ${res.headSha.slice(0, 10)} (advisory mode).`);
    } finally {
      ledger.close();
    }
  });

program
  .command("disagree <issue>")
  .description("Record a Shadow Mode disagreement (marks factory:disagree on GitHub + Ledger)")
  .action(async (issueArg: string) => {
    const cfg = loadConfigFromEnv();
    const paths = resolvePaths(cfg);
    const ledger = new Ledger(paths.ledgerDbPath, { timeZone: cfg.dailyTimezone });
    try {
      const issueNumber = Number(issueArg);
      ledger.markShadowDisagree(issueNumber, true);
      const github = new GitHubAppClient({
        owner: cfg.githubOwner,
        repo: cfg.githubRepo,
        appId: cfg.githubAppId,
        installationId: cfg.githubInstallationId,
        privateKeyPem: cfg.githubPrivateKeyPem,
      });
      await github.addLabels(issueNumber, [cfg.labels.disagree]);
      const stats = ledger.getShadowStats();
      console.log(
        `Recorded Shadow Mode disagreement on #${issueNumber}. Agreement: ${stats.agreed}/${stats.total} (${Math.round(stats.agreementRate * 100)}%).`,
      );
    } finally {
      ledger.close();
    }
  });

program
  .command("reset-breaker")
  .description("Reset the global red-main landing circuit breaker after main is green")
  .option("--data-dir <dir>", "Archangel data directory", process.env.ARCHANGEL_DATA_DIR ?? ".archangel")
  .action((opts: { dataDir: string }) => {
    const paths = resolvePaths({ dataDir: opts.dataDir });
    const ledger = new Ledger(paths.ledgerDbPath);
    try {
      ledger.setCircuitBreaker(false, "manually reset by owner");
      console.log("Global landing circuit breaker reset.");
    } finally {
      ledger.close();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
