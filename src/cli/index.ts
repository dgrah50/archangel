#!/usr/bin/env node
import { Command } from "commander";
import { loadProjectConfigs, resolvePaths, type ArchangelConfig } from "../config.js";
import { ClaudeSdkImplementer } from "../agents/implementer.js";
import { MastraReviewerSuite } from "../agents/reviewers.js";
import { GitBroker } from "../broker/git-broker.js";
import { TelegramNotifier } from "../core/notifier.js";
import { Reconciler } from "../core/reconciler.js";
import { GitHubAppClient } from "../github/client.js";
import { handoffThreadToPaseo, PaseoCliRunner, resumeThreadFromPaseo } from "../handoff/paseo.js";
import { Ledger } from "../ledger/store.js";

const program = new Command();

function pickProjectConfig(configs: ArchangelConfig[], repoFlag?: string): ArchangelConfig {
  if (repoFlag) {
    const match = configs.find((c) => `${c.githubOwner}/${c.githubRepo}` === repoFlag);
    if (!match) {
      throw new Error(
        `Project ${repoFlag} not found in config (available: ${configs
          .map((c) => `${c.githubOwner}/${c.githubRepo}`)
          .join(", ")})`,
      );
    }
    return match;
  }
  if (configs.length > 1) {
    throw new Error(
      `Multiple projects configured; pass --repo <owner/name> (${configs
        .map((c) => `${c.githubOwner}/${c.githubRepo}`)
        .join(", ")})`,
    );
  }
  return configs[0]!;
}

program
  .name("archangel")
  .description("Archangel autonomous software factory CLI")
  .version("0.1.0");

program
  .command("start")
  .description("Start the level-triggered Archangel reconciler daemon")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--once", "Run a single reconciliation tick across all configured projects and exit")
  .action(async (opts: { config?: string; once?: boolean }) => {
    const projects = loadProjectConfigs({ configPath: opts.config });
    const first = projects[0]!;
    const sharedPaths = resolvePaths(first);

    if (!opts.once) {
      console.log(
        "[archangel] Tip: run under `caffeinate -i archangel start` on macOS laptops to avoid sleep mid-Attempt.",
      );
    }
    console.log(
      `[archangel] Loaded ${projects.length} project(s): ${projects
        .map((p) => `${p.githubOwner}/${p.githubRepo}`)
        .join(", ")}`,
    );

    if (!first.anthropicApiKey || !first.openaiApiKey || !first.googleApiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY, OPENAI_API_KEY, and GOOGLE_GENERATIVE_AI_API_KEY (or GEMINI_API_KEY) are required.",
      );
    }

    const rootLedger = new Ledger(sharedPaths.ledgerDbPath, { timeZone: first.dailyTimezone });
    const reviewers = new MastraReviewerSuite({
      openaiApiKey: first.openaiApiKey,
      googleApiKey: first.googleApiKey,
      openaiModel: first.openaiReviewerModel,
      geminiModel: first.geminiReviewerModel,
      mastraDbPath: sharedPaths.mastraDbPath,
    });
    const notifier = new TelegramNotifier({
      botToken: first.telegramBotToken,
      chatId: first.telegramChatId,
    });

    const reconcilers = projects.map((cfg) => {
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
        maxNonTestLines: cfg.gate.maxNonTestLines,
        maxTotalLines: cfg.gate.maxTotalLines,
        maxFiles: cfg.gate.maxFiles,
        extraProtectedPaths: cfg.gate.extraProtectedPaths,
      });
      const implementer = new ClaudeSdkImplementer({
        apiKey: first.anthropicApiKey!,
        model: cfg.claudeModel,
        transcriptsDir: paths.transcriptsDir,
      });
      const rec = new Reconciler({
        config: cfg,
        ledger: rootLedger.forRepo(repoSlug),
        github,
        broker,
        implementer,
        reviewers,
        notifier,
      });
      const swept = rec.startupSweep();
      if (swept.length > 0) {
        console.log(`[archangel] [${repoSlug}] Stale-run sweep recovered threads: ${swept.join(", ")}`);
      }
      return { repoSlug, rec };
    });

    const runTick = async () => {
      for (const { repoSlug, rec } of reconcilers) {
        try {
          await rec.tick();
        } catch (err) {
          console.error(`[archangel] [${repoSlug}] Tick error:`, err);
        }
      }
    };

    await runTick();
    if (opts.once) {
      rootLedger.close();
      return;
    }

    const timer = setInterval(runTick, first.pollIntervalMs);
    const shutdown = () => {
      clearInterval(timer);
      rootLedger.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("status")
  .description("Show Threads, Needs You queue, spend, merges, and Shadow Mode agreement")
  .option("--data-dir <dir>", "Archangel data directory", process.env.ARCHANGEL_DATA_DIR ?? ".archangel")
  .option("--repo <owner/name>", "Filter by repository")
  .option("--json", "Output JSON")
  .action((opts: { dataDir: string; repo?: string; json?: boolean }) => {
    const paths = resolvePaths({ dataDir: opts.dataDir });
    const ledger = new Ledger(paths.ledgerDbPath, { readonly: true });
    try {
      const threads = opts.repo ? ledger.listThreads(undefined, opts.repo) : ledger.listAllThreads();
      const shadow = ledger.getShadowStats(opts.repo ?? null);
      const spendToday = ledger.getSpendToday();
      const autoMergesToday = ledger.getAutoMergeCountToday(Date.now(), opts.repo ?? null);
      const repos = [...new Set(threads.map((t) => t.repo))];
      const breakers = Object.fromEntries(repos.map((r) => [r, ledger.getCircuitBreaker(r)]));

      const payload = {
        spendTodayUsd: Number(spendToday.toFixed(4)),
        autoMergesToday,
        circuitBreakers: breakers,
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
      console.log(
        `Shadow agreement: ${shadow.agreed}/${shadow.total} (${Math.round(shadow.agreementRate * 100)}%)`,
      );
      for (const [r, b] of Object.entries(breakers)) {
        if (b.tripped) console.log(`Circuit breaker:  ${r} TRIPPED (${b.reason})`);
      }
      console.log("");
      if (threads.length === 0) {
        console.log("No threads recorded in Ledger yet.");
        return;
      }
      for (const t of threads) {
        const pr = t.prNumber ? `PR #${t.prNumber}` : "no PR";
        const note = t.needsYouReason ? ` — ${t.needsYouReason}` : "";
        console.log(`${t.repo}#${t.issueNumber}  [${t.state}]  ${pr}  ${t.title}${note}`);
      }
    } finally {
      ledger.close();
    }
  });

program
  .command("events")
  .description("Inspect the append-only Ledger audit log")
  .option("--data-dir <dir>", "Archangel data directory", process.env.ARCHANGEL_DATA_DIR ?? ".archangel")
  .option("--repo <owner/name>", "Filter by repository")
  .option("--topic <prefix>", "Filter by topic prefix")
  .option("--issue <number>", "Filter by issue number")
  .option("--limit <n>", "Max entries", "40")
  .action((opts: { dataDir: string; repo?: string; topic?: string; issue?: string; limit: string }) => {
    const paths = resolvePaths({ dataDir: opts.dataDir });
    const ledger = new Ledger(paths.ledgerDbPath, { readonly: true });
    try {
      const entries = ledger.listAudit({
        repo: opts.repo,
        topicPrefix: opts.topic,
        issueNumber: opts.issue ? Number(opts.issue) : undefined,
        limit: Number(opts.limit),
      });
      for (const e of entries.reverse()) {
        const ts = new Date(e.ts).toISOString();
        const issueStr = e.issueNumber ? `${e.repo ?? ""}#${e.issueNumber}` : (e.repo ?? "-");
        console.log(`${ts}  ${e.topic}  ${issueStr}  (${e.actor})  ${e.payloadJson}`);
      }
    } finally {
      ledger.close();
    }
  });

program
  .command("handoff <issue>")
  .description("Pause factory autonomy and hand off a Thread to Paseo")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--repo <owner/name>", "Target repository (required when multiple projects configured)")
  .option("--repo-dir <dir>", "Local repo path for Paseo worktree creation")
  .action(async (issueArg: string, opts: { config?: string; repo?: string; repoDir?: string }) => {
    const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), opts.repo);
    const repoSlug = `${cfg.githubOwner}/${cfg.githubRepo}`;
    const paths = resolvePaths(cfg);
    const ledger = new Ledger(paths.ledgerDbPath, { repo: repoSlug, timeZone: cfg.dailyTimezone });
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
        maxNonTestLines: cfg.gate.maxNonTestLines,
        maxTotalLines: cfg.gate.maxTotalLines,
        maxFiles: cfg.gate.maxFiles,
        extraProtectedPaths: cfg.gate.extraProtectedPaths,
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
        `Handed off ${repoSlug}#${issueArg} on ${res.branchName} to Paseo (agent=${res.agentId}, workspace=${res.workspaceId ?? "n/a"})`,
      );
    } finally {
      ledger.close();
    }
  });

program
  .command("resume <issue>")
  .description("Resume advisory Gate & Review tracking after Paseo Handoff (owner merges manually)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--repo <owner/name>", "Target repository")
  .action(async (issueArg: string, opts: { config?: string; repo?: string }) => {
    const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), opts.repo);
    const repoSlug = `${cfg.githubOwner}/${cfg.githubRepo}`;
    const paths = resolvePaths(cfg);
    const ledger = new Ledger(paths.ledgerDbPath, { repo: repoSlug, timeZone: cfg.dailyTimezone });
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
      console.log(
        `Resumed ${repoSlug}#${issueArg} at owner-authorized SHA ${res.headSha.slice(0, 10)} (advisory mode).`,
      );
    } finally {
      ledger.close();
    }
  });

program
  .command("disagree <issue>")
  .description("Record a Shadow Mode disagreement (marks factory:disagree on GitHub + Ledger)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--repo <owner/name>", "Target repository")
  .action(async (issueArg: string, opts: { config?: string; repo?: string }) => {
    const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), opts.repo);
    const repoSlug = `${cfg.githubOwner}/${cfg.githubRepo}`;
    const paths = resolvePaths(cfg);
    const ledger = new Ledger(paths.ledgerDbPath, { repo: repoSlug, timeZone: cfg.dailyTimezone });
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
      const stats = ledger.getShadowStats(repoSlug);
      console.log(
        `Recorded Shadow Mode disagreement on ${repoSlug}#${issueNumber}. Agreement: ${stats.agreed}/${stats.total} (${Math.round(stats.agreementRate * 100)}%).`,
      );
    } finally {
      ledger.close();
    }
  });

program
  .command("reset-breaker")
  .description("Reset a repo's red-main landing circuit breaker after main is green")
  .option("--data-dir <dir>", "Archangel data directory", process.env.ARCHANGEL_DATA_DIR ?? ".archangel")
  .option("--repo <owner/name>", "Target repository", "dgrah50/gijq")
  .action((opts: { dataDir: string; repo: string }) => {
    const paths = resolvePaths({ dataDir: opts.dataDir });
    const ledger = new Ledger(paths.ledgerDbPath, { repo: opts.repo });
    try {
      ledger.setCircuitBreaker(false, "manually reset by owner");
      console.log(`Circuit breaker reset for ${opts.repo}.`);
    } finally {
      ledger.close();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
