#!/usr/bin/env node
import fs from "node:fs";
import { Command } from "commander";
import { loadDotEnv } from "../env.js";
import { loadProjectConfigs, providerToVendor, resolvePaths, type ArchangelConfig } from "../config.js";
import { ClaudeSdkImplementer } from "../agents/implementer.js";
import { MastraReviewerSuite, type ReviewerSuite } from "../agents/reviewers.js";
import { SubscriptionImplementer } from "../agents/subscription-implementer.js";
import { SubscriptionReviewerSuite } from "../agents/subscription-reviewers.js";
import { GitBroker } from "../broker/git-broker.js";
import { runDoctor } from "../core/doctor.js";
import { TelegramNotifier } from "../core/notifier.js";
import { Reconciler, sha256 } from "../core/reconciler.js";
import { launchStudio } from "../core/studio.js";
import { extractPrFromPhase, stepPhase } from "../core/thread-machine.js";
import { runGate } from "../gate/gate.js";
import { GitHubAppClient } from "../github/client.js";
import { handoffThreadToPaseo, PaseoCliRunner, resumeThreadFromPaseo } from "../handoff/paseo.js";
import { Ledger } from "../ledger/store.js";

// Auto-load local `.env` before reading config (never overrides existing shell env).
loadDotEnv();

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

function resolveDataDirFromOpts(opts: { config?: string; dataDir?: string }): string {
  if (opts.dataDir) return opts.dataDir;
  if (opts.config || fs.existsSync("archangel.yaml")) {
    try {
      const cfgs = loadProjectConfigs({ configPath: opts.config });
      if (cfgs[0]) return cfgs[0].dataDir;
    } catch {
      // Fallback to default dataDir when reading status/events without full secrets
    }
  }
  return process.env.ARCHANGEL_DATA_DIR ?? ".archangel";
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
    const daemonOwnerId = `daemon-${process.pid}-${Date.now()}`;

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

    if (
      first.authMode === "api" &&
      (!first.anthropicApiKey || !first.openaiApiKey || !first.googleApiKey)
    ) {
      throw new Error(
        "authMode=api requires ANTHROPIC_API_KEY, OPENAI_API_KEY, and GOOGLE_GENERATIVE_AI_API_KEY (or set authMode: subscription in archangel.yaml).",
      );
    }

    const rootLedger = new Ledger(sharedPaths.ledgerDbPath, { timeZone: first.dailyTimezone });

    // Single daemon lock prevents `start` and `start --once` from colliding or sweeping live work (Opus R9 / Codex #6).
    if (!rootLedger.acquireDaemonLock(daemonOwnerId, first.staleLeaseMs)) {
      rootLedger.close();
      throw new Error("Another live Archangel daemon already holds the Ledger lock.");
    }

    const lockHeartbeat = setInterval(() => {
      rootLedger.heartbeatDaemonLock(daemonOwnerId);
    }, 30_000);

    const reviewers: ReviewerSuite =
      first.authMode === "subscription"
        ? new SubscriptionReviewerSuite({
            chain: first.reviewerChain,
            primaryImplementerVendor: providerToVendor(first.implementerChain[0]!.provider),
          })
        : new MastraReviewerSuite({
            openaiApiKey: first.openaiApiKey!,
            googleApiKey: first.googleApiKey!,
            openaiModel: first.openaiReviewerModel,
            geminiModel: first.geminiReviewerModel,
            mastraDbPath: sharedPaths.mastraDbPath,
          });
    const notifier = new TelegramNotifier({
      botToken: first.telegramBotToken,
      chatId: first.telegramChatId,
    });

    console.log(
      first.authMode === "subscription"
        ? `[archangel] Auth mode: subscription (impl=${first.implementerChain.map((e) => e.provider).join("->")}, reviewers=${first.reviewerChain.map((e) => e.provider).join("->")})`
        : "[archangel] Auth mode: api (metered keys)",
    );

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
        testFileGlobs: cfg.gate.testFileGlobs,
        testDataGlobs: cfg.gate.testDataGlobs,
        testBuildCmd: cfg.gate.testBuildCmd,
        testCmd: cfg.gate.testCmd,
        enableLocalGate: true,
        // H1: run diff/path/immutability/pre-commit locally; let ephemeral CI VM execute untrusted agent test binaries.
        localGateSkipTests: true,
      });
      const pemPath = process.env.ARCHANGEL_GITHUB_PRIVATE_KEY_PATH?.trim();
      const implementer =
        cfg.authMode === "subscription"
          ? new SubscriptionImplementer({
              chain: cfg.implementerChain,
              transcriptsDir: paths.transcriptsDir,
            })
          : new ClaudeSdkImplementer({
              apiKey: first.anthropicApiKey!,
              model: cfg.claudeModel,
              transcriptsDir: paths.transcriptsDir,
              denyReadPaths: [paths.dataDir, ...(pemPath ? [pemPath] : [])],
            });
      const rec = new Reconciler({
        config: cfg,
        ledger: rootLedger.forRepo(repoSlug),
        github,
        broker,
        implementer,
        reviewers,
        notifier,
        workerId: daemonOwnerId,
      });
      const swept = rec.startupSweep();
      if (swept.length > 0) {
        console.log(`[archangel] [${repoSlug}] Stale-working sweep recovered threads: ${swept.join(", ")}`);
      }
      return { repoSlug, rec };
    });

    let stopping = false;
    let nextTimer: NodeJS.Timeout | null = null;

    const runTick = async () => {
      for (const { repoSlug, rec } of reconcilers) {
        if (stopping) break;
        try {
          await rec.tick(Date.now(), { waitForAttempts: Boolean(opts.once) });
        } catch (err) {
          console.error(`[archangel] [${repoSlug}] Tick error:`, err);
        }
      }
    };

    const cleanup = async () => {
      stopping = true;
      if (nextTimer) clearTimeout(nextTimer);
      clearInterval(lockHeartbeat);
      for (const { rec } of reconcilers) {
        rec.abortAllActive("control");
        await rec.waitForActiveTasks();
      }
      rootLedger.releaseDaemonLock(daemonOwnerId);
      rootLedger.close();
    };

    if (opts.once) {
      try {
        await runTick();
      } finally {
        await cleanup();
      }
      return;
    }

    const scheduleNext = () => {
      if (stopping) return;
      nextTimer = setTimeout(async () => {
        await runTick();
        scheduleNext();
      }, first.pollIntervalMs);
    };

    process.on("SIGINT", () => {
      void cleanup().finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      void cleanup().finally(() => process.exit(0));
    });

    await runTick();
    scheduleNext();
  });

program
  .command("gate")
  .description("Run the language-agnostic mechanical Gate against a git repository (reads .pre-commit-config.yaml and .agents/landing.json from base)")
  .option("--repo <dir>", "Path to git repository (normal or bare)", ".")
  .requiredOption("--base <ref>", "Base commit/branch ref (e.g. main)")
  .option("--head <ref>", "Head commit/branch ref", "HEAD")
  .option("--policy-from-base", "Read .agents/landing.json strictly from base commit", false)
  .option("--revert-of <sha>", "Verify exact-inverse revert of recorded squash commit SHA")
  .option("--base-runs <n>", "Override red-on-base run count")
  .option("--head-runs <n>", "Override green-on-head run count")
  .option("--skip-pre-commit", "Skip repo .pre-commit-config.yaml hooks", false)
  .option("--skip-tests", "Skip red-on-base / green-on-head test execution", false)
  .action(
    async (opts: {
      repo: string;
      base: string;
      head: string;
      policyFromBase?: boolean;
      revertOf?: string;
      baseRuns?: string;
      headRuns?: string;
      skipPreCommit?: boolean;
      skipTests?: boolean;
    }) => {
      try {
        const report = await runGate({
          repoDir: opts.repo,
          baseRef: opts.base,
          headRef: opts.head,
          policyFromBase: Boolean(opts.policyFromBase),
          revertOf: opts.revertOf,
          baseRunsOverride: opts.baseRuns ? Number(opts.baseRuns) : undefined,
          headRunsOverride: opts.headRuns ? Number(opts.headRuns) : undefined,
          skipPreCommit: Boolean(opts.skipPreCommit),
          skipTests: Boolean(opts.skipTests),
        });
        console.log(JSON.stringify(report, null, 2));
        process.exit(report.passed ? 0 : 1);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    },
  );

program
  .command("doctor")
  .description("Run offline & online preflight checks (config, PEM, tools, GitHub App least-privilege permissions)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--offline", "Skip GitHub API and Paseo daemon network checks")
  .option("--json", "Output JSON")
  .action(async (opts: { config?: string; offline?: boolean; json?: boolean }) => {
    const report = await runDoctor({ configPath: opts.config, offline: opts.offline });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const c of report.checks) {
        const icon = c.status === "pass" ? "PASS" : c.status === "warn" ? "WARN" : "FAIL";
        console.log(`[${icon}] ${c.name}: ${c.detail}`);
        if (c.remediation) console.log(`       Fix: ${c.remediation}`);
      }
      console.log(`\nDoctor verdict: ${report.ok ? "READY" : "FAILED"}`);
    }
    if (!report.ok) process.exit(1);
  });

program
  .command("studio")
  .description("Launch read-only Mastra Studio on 127.0.0.1 pointed strictly at mastra.db")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--data-dir <dir>", "Archangel data directory")
  .option("--port <n>", "Loopback port", "4111")
  .action(async (opts: { config?: string; dataDir?: string; port: string }) => {
    const dataDir = resolveDataDirFromOpts(opts);
    const paths = resolvePaths({ dataDir });
    const code = await launchStudio({
      mastraDbPath: paths.mastraDbPath,
      ledgerDbPath: paths.ledgerDbPath,
      port: Number(opts.port),
    });
    process.exit(code);
  });

program
  .command("status")
  .description("Show Threads, Needs You queue, spend, merges, and Shadow Mode agreement")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--data-dir <dir>", "Archangel data directory")
  .option("--repo <owner/name>", "Filter by repository")
  .option("--json", "Output JSON")
  .action((opts: { config?: string; dataDir?: string; repo?: string; json?: boolean }) => {
    const dataDir = resolveDataDirFromOpts(opts);
    const paths = resolvePaths({ dataDir });
    if (!fs.existsSync(paths.ledgerDbPath)) {
      const empty = { message: `No Ledger found yet at ${paths.ledgerDbPath}. Run \`archangel start\` first.` };
      console.log(opts.json ? JSON.stringify(empty, null, 2) : empty.message);
      return;
    }
    const ledger = new Ledger(paths.ledgerDbPath, { readonly: true });
    try {
      const threads = opts.repo ? ledger.listThreads(undefined, opts.repo) : ledger.listAllThreads();
      const shadow = ledger.getShadowStats(opts.repo ?? null);
      const spend = ledger.getSpendBreakdown();
      const autoMergesToday = ledger.getAutoMergeCountToday(Date.now(), opts.repo ?? null);
      const repos = [...new Set(threads.map((t) => t.repo))];
      const breakers = Object.fromEntries(repos.map((r) => [r, ledger.getCircuitBreaker(r)]));

      const payload = {
        spendTodayUsd: Number(spend.spentUsd.toFixed(4)),
        reservedUsd: Number(spend.reservedUsd.toFixed(4)),
        autoMergesToday,
        circuitBreakers: breakers,
        shadowModeStats: shadow,
        needsYou: threads.filter((t) => t.phase.kind === "needs_you"),
        threads,
      };

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(`Spend today:      $${payload.spendTodayUsd.toFixed(2)} (reserved: $${payload.reservedUsd.toFixed(2)})`);
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
        const pr = extractPrFromPhase(t.phase);
        const prStr = pr ? `PR #${pr.prNumber}` : "no PR";
        const note = t.phase.kind === "needs_you" ? ` — [${t.phase.code}] ${t.phase.reason}` : "";
        console.log(`${t.repo}#${t.issueNumber}  [${t.phase.kind}/${t.mode}]  ${prStr}  ${t.title}${note}`);
      }
    } finally {
      ledger.close();
    }
  });

program
  .command("events")
  .description("Inspect the append-only Ledger audit log")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--data-dir <dir>", "Archangel data directory")
  .option("--repo <owner/name>", "Filter by repository")
  .option("--topic <prefix>", "Filter by topic prefix")
  .option("--issue <number>", "Filter by issue number")
  .option("--limit <n>", "Max entries", "40")
  .action((opts: { config?: string; dataDir?: string; repo?: string; topic?: string; issue?: string; limit: string }) => {
    const dataDir = resolveDataDirFromOpts(opts);
    const paths = resolvePaths({ dataDir });
    if (!fs.existsSync(paths.ledgerDbPath)) {
      console.log(`No Ledger found yet at ${paths.ledgerDbPath}.`);
      return;
    }
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
  .option("--repo <owner/name>", "Target repository")
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
        `Resumed ${repoSlug}#${issueArg} at owner-authorized SHA ${res.headSha?.slice(0, 10) ?? "none"} (advisory mode).`,
      );
    } finally {
      ledger.close();
    }
  });

program
  .command("retry <issue>")
  .description("Clear needs_you on a Thread, re-snapshot its issue body, and return it to its resume target")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--repo <owner/name>", "Target repository")
  .action(async (issueArg: string, opts: { config?: string; repo?: string }) => {
    const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), opts.repo);
    const repoSlug = `${cfg.githubOwner}/${cfg.githubRepo}`;
    const paths = resolvePaths(cfg);
    const ledger = new Ledger(paths.ledgerDbPath, { repo: repoSlug, timeZone: cfg.dailyTimezone });
    try {
      const issueNumber = Number(issueArg);
      const thread = ledger.getThread(issueNumber);
      if (!thread) throw new Error(`Thread ${repoSlug}#${issueNumber} not found`);
      const github = new GitHubAppClient({
        owner: cfg.githubOwner,
        repo: cfg.githubRepo,
        appId: cfg.githubAppId,
        installationId: cfg.githubInstallationId,
        privateKeyPem: cfg.githubPrivateKeyPem,
      });
      const issue = await github.getIssue(issueNumber);
      const stepped = stepPhase(
        thread.phase,
        thread.mode,
        { t: "owner_retry" },
        { issueNumber, title: thread.title, needsYouLabel: cfg.labels.needsYou },
      );
      if (!stepped.ok) throw new Error(stepped.reject);
      await github.removeLabel(issueNumber, cfg.labels.needsYou);
      ledger.transition(issueNumber, thread.version, stepped.next, {
        bodySha256: sha256(issue.body),
        auditTopic: "thread/owner_retried",
      });
      console.log(`Retried ${repoSlug}#${issueNumber} -> phase '${stepped.next.kind}'.`);
    } finally {
      ledger.close();
    }
  });

program
  .command("abandon <issue>")
  .description("Explicitly move a Thread to done(abandoned)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--repo <owner/name>", "Target repository")
  .action((issueArg: string, opts: { config?: string; repo?: string }) => {
    const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), opts.repo);
    const repoSlug = `${cfg.githubOwner}/${cfg.githubRepo}`;
    const paths = resolvePaths(cfg);
    const ledger = new Ledger(paths.ledgerDbPath, { repo: repoSlug, timeZone: cfg.dailyTimezone });
    try {
      const issueNumber = Number(issueArg);
      const thread = ledger.getThread(issueNumber);
      if (!thread) throw new Error(`Thread ${repoSlug}#${issueNumber} not found`);
      const stepped = stepPhase(
        thread.phase,
        thread.mode,
        { t: "owner_abandon" },
        { issueNumber, title: thread.title, needsYouLabel: cfg.labels.needsYou },
      );
      if (!stepped.ok) throw new Error(stepped.reject);
      ledger.transition(issueNumber, thread.version, stepped.next, {
        auditTopic: "thread/owner_abandoned",
      });
      console.log(`Abandoned ${repoSlug}#${issueNumber}.`);
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
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--data-dir <dir>", "Archangel data directory")
  .option("--repo <owner/name>", "Target repository", "dgrah50/gijq")
  .action((opts: { config?: string; dataDir?: string; repo: string }) => {
    const dataDir = resolveDataDirFromOpts(opts);
    const paths = resolvePaths({ dataDir });
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
