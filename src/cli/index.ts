#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tryParseJson } from "../core/json.js";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { Command } from "commander";
import { loadDotEnv } from "../env.js";
import { resolveDataDir, resolveHostSettings } from "./data-dir.js";
import { INIT_NEXT_STEPS, runInit } from "./init.js";
import { requireTransition } from "./transition.js";
import { loadProjectConfigs, primaryWriterVendors, resolveConfigPath, resolvePaths, WRITER_ROLES, type ArchangelConfig, type WriterRole } from "../config.js";
import { ClaudeSdkImplementer } from "../agents/implementer.js";
import { MastraReviewerSuite, type ReviewerSuite } from "../agents/reviewers.js";
import { SubscriptionImplementer } from "../agents/subscription-implementer.js";
import { SubscriptionReviewerSuite } from "../agents/subscription-reviewers.js";
import { GitBroker } from "../broker/git-broker.js";
import { runDoctor } from "../core/doctor.js";
import { ArchangelLogger } from "../core/logger.js";
import { sendDigestIfDue } from "../core/digest.js";
import { gateBump } from "../core/gate-pin.js";
import { proposeWorkflow } from "../core/workflow-propose.js";
import { renderCounts, renderEval, runEval, collectEvalCases, milestoneProgress, EVAL_THRESHOLDS } from "../core/eval.js";
import { prepareCandidates } from "../core/eval-candidate.js";
import { BENCH, parseChain, renderBench, runBenchTiers } from "../core/bench-tiers.js";
import { ARCHANGEL_ROOT } from "../core/onboard.js";
import { saveReport } from "../core/eval-reports.js";
import { renderReplay, runReplay, type ReplayReport } from "../core/replay.js";
import { execRunner, onboard } from "../core/onboard.js";
import { bump, bumpRunner } from "../core/bump.js";
import { TelegramNotifier } from "../core/notifier.js";
import { computeHealth, renderHealth, renderStages } from "../core/status-text.js";
import { recordDaemonFacts } from "../core/host-facts.js";
import { assertBindable, startUiServer } from "../core/ui-server.js";
import { groupThreads } from "../core/ui-state.js";
import { Reconciler, sha256 } from "../core/reconciler.js";
import { runScoutsForProject, defaultScoutCliInvoker } from "../core/scout.js";
import { ARCHANGEL_REPO, ghPrStatus, openDraftPr } from "../core/correction-draft.js";
import { SandboxExecProvider, stopAllPreviews, sweepOrphanPreviews } from "../compute/sandbox-exec.js";
import { execFileGroup } from "../core/spawn-group.js";
import { promotePitch } from "../core/pitch-promote.js";
import { loadWorkflow, requireOkWorkflow } from "../core/workflow-load.js";
import { launchStudio } from "../core/studio.js";
import { extractPrFromPhase, stepPhase } from "../core/thread-machine.js";
import { correctionCategories } from "../core/corrections.js";
import { describeEscalation, formatDecisionClass } from "../core/escalations.js";
import { collectOwnerReply } from "../core/owner-reply.js";
import { listAllSkills } from "../core/skills.js";
import { runGate } from "../gate/gate.js";
import { GitHubAppClient } from "../github/client.js";
import { handoffThreadToPaseo, PaseoCliRunner, resumeThreadFromPaseo } from "../handoff/paseo.js";
import { Ledger } from "../ledger/store.js";
import { setTelemetrySink, TELEMETRY_PRUNE_BATCH, TELEMETRY_RETENTION_MS } from "../core/telemetry.js";

// Auto-load local `.env` before reading config (never overrides existing shell env).
loadDotEnv();

function makeReviewerSuite(cfg: ArchangelConfig, mastraDbPath: string, ledger: Ledger): ReviewerSuite {
  return cfg.authMode === "subscription"
    ? new SubscriptionReviewerSuite({
        chain: cfg.reviewerChain,
        accounts: cfg.accounts,
        accountState: ledger.accountState(cfg.accounts),
        defaultExcludeVendors: primaryWriterVendors(cfg.chains),
      })
    : new MastraReviewerSuite({
        openaiApiKey: cfg.openaiApiKey!,
        googleApiKey: cfg.googleApiKey!,
        openaiModel: cfg.openaiReviewerModel,
        geminiModel: cfg.geminiReviewerModel,
        mastraDbPath,
      });
}

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
  .command("init")
  .description("Create archangel.yaml, .env and an empty Ledger in the current directory (never overwrites; safe to rerun)")
  .action(() => {
    const lines = runInit(process.cwd());
    console.log(lines.join("\n"));
    console.log(lines.every((l) => !l.startsWith("created")) ? "\nNothing to do: already initialised." : "");
    console.log(["Next steps:", ...INIT_NEXT_STEPS.map((c, i) => `  ${i + 1}. ${c}`)].join("\n"));
  });

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

    recordDaemonFacts(rootLedger, { configPath: opts.config });
    setTelemetrySink(rootLedger);

    // Lost lock (laptop slept past staleLeaseMs and another daemon took over): stop now, loudly, rather than tick as a second daemon.
    const lockHeartbeat = setInterval(() => {
      if (rootLedger.heartbeatDaemonLock(daemonOwnerId)) return;
      console.error("[archangel] Lost the Ledger daemon lock to another process; shutting down.");
      void cleanup().finally(() => process.exit(1));
    }, 30_000);

    const reviewers = makeReviewerSuite(first, sharedPaths.mastraDbPath, rootLedger);
    const notifier = new TelegramNotifier({
      botToken: first.telegramBotToken,
      chatId: first.telegramChatId,
    });
    const logger = new ArchangelLogger({
      logFilePath: path.join(sharedPaths.dataDir, "archangel.log.jsonl"),
      consoleOutput: true,
    });
    const accountState = rootLedger.accountState(first.accounts);

    logger.info(
      "daemon/started",
      first.authMode === "subscription"
        ? `Auth mode: subscription (impl=${first.chains.implement.map((e) => e.provider).join("->")}, revise=${first.chains.revise.map((e) => e.provider).join("->")}, rebase=${first.chains.rebase.map((e) => e.provider).join("->")}, scout=${first.chains.scout.map((e) => e.provider).join("->")}, reviewers=${first.reviewerChain.map((e) => e.provider).join("->")})`
        : "Auth mode: api (metered keys)",
    );

    /** Each watched repo's App client and Broker, so the correction loop can open a draft PR as the App on Archangel's own repo. */
    const appClients = new Map<string, { github: GitHubAppClient; broker: GitBroker; defaultBranch: string }>();
    const digestSources: Array<{ repoSlug: string; github: GitHubAppClient; agentProposedLabel: string }> = [];
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
        enableLocalGate: true,
        // H1: run diff/path/immutability/pre-commit locally; let ephemeral CI VM execute untrusted agent test binaries.
        localGateSkipTests: true,
      });
      const pemPath = process.env.ARCHANGEL_GITHUB_PRIVATE_KEY_PATH?.trim();
      const implementer =
        cfg.authMode === "subscription"
          ? new SubscriptionImplementer({
              chains: cfg.chains,
              accounts: cfg.accounts,
              transcriptsDir: paths.transcriptsDir,
              accountState,
              logger,
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
        logger,
        workerId: daemonOwnerId,
        // Correction-loop drafts need the subscription CLIs (Scout drafter and eval reviewers); with api auth they are off.
        correctionDrafts:
          cfg.authMode === "subscription"
            ? {
                invoker: defaultScoutCliInvoker,
                cwd: ARCHANGEL_ROOT,
                skills: listAllSkills(),
                evaluate: async (patchFile, heldout) => {
                  const { baseline, candidate } = await prepareCandidates(ARCHANGEL_ROOT, patchFile);
                  try {
                    return await runEval({
                      ledger: rootLedger,
                      sources: evalSources(rootLedger, sharedPaths.dataDir),
                      suiteFor: (prompts) => new SubscriptionReviewerSuite({ chain: first.reviewerChain, defaultExcludeVendors: primaryWriterVendors(first.chains), prompts }),
                      baseline: baseline.prompts,
                      candidate,
                      heldout,
                    });
                  } finally {
                    candidate.cleanup();
                  }
                },
                openPr: (draft, body, ctx) => {
                  const client = appClients.get(ARCHANGEL_REPO);
                  if (!client) throw new Error(`${ARCHANGEL_REPO} is not a watched project, so there is no App client to open the draft PR with`);
                  return openDraftPr(client, draft, body, ctx);
                },
                prStatus: (url) => ghPrStatus(execRunner, url),
              }
            : undefined,
      });
      const swept = rec.startupSweep();
      if (swept.length > 0) {
        console.log(`[archangel] [${repoSlug}] Stale-working sweep recovered threads: ${swept.join(", ")}`);
      }
      digestSources.push({ repoSlug, github, agentProposedLabel: cfg.labels.agentProposed });
      appClients.set(repoSlug, { github, broker, defaultBranch: cfg.defaultBranch });
      return { repoSlug, rec };
    });

    let stopping = false;
    let nextTimer: NodeJS.Timeout | null = null;
    let inFlightTick: Promise<void> | null = null;
    let cleanupDone: Promise<void> | null = null;

    const runTick = (): Promise<void> => {
      inFlightTick = runTickBody().finally(() => {
        inFlightTick = null;
      });
      return inFlightTick;
    };

    const runTickBody = async () => {
      try {
        const swept = await sweepOrphanPreviews();
        if (swept.length > 0) console.log(`[archangel] Killed orphan preview(s): ${swept.join(", ")}`);
      } catch (err) {
        console.error("[archangel] Preview sweep error:", err);
      }
      for (const { repoSlug, rec } of reconcilers) {
        if (stopping) break;
        try {
          await rec.tick(Date.now(), { waitForAttempts: Boolean(opts.once) });
        } catch (err) {
          console.error(`[archangel] [${repoSlug}] Tick error:`, err);
        }
      }
      try {
        rootLedger.pruneTelemetry(Date.now() - TELEMETRY_RETENTION_MS, TELEMETRY_PRUNE_BATCH);
      } catch (err) {
        console.error("[archangel] Telemetry prune error:", err);
      }
      try {
        await sendDigestIfDue(rootLedger, notifier, {
          now: Date.now(),
          timeZone: first.dailyTimezone,
          digestHour: first.digestHour,
          openProposals: async () => {
            const open = new Set<string>();
            for (const { repoSlug, github, agentProposedLabel } of digestSources) {
              for (const issue of await github.listOpenIssuesByLabel(agentProposedLabel)) open.add(`${repoSlug}#${issue.number}`);
            }
            return open;
          },
        });
      } catch (err) {
        console.error("[archangel] Digest error:", err);
      }
    };

    // Idempotent (a second signal joins the first) and waits for the tick in flight, so nothing wakes on a closed Ledger.
    const cleanup = (): Promise<void> => {
      cleanupDone ??= (async () => {
        stopping = true;
        if (nextTimer) clearTimeout(nextTimer);
        clearInterval(lockHeartbeat);
        stopAllPreviews();
        for (const { rec } of reconcilers) {
          rec.abortAllActive("control");
          await rec.waitForActiveTasks();
        }
        await inFlightTick;
        setTelemetrySink(null);
        rootLedger.releaseDaemonLock(daemonOwnerId);
        rootLedger.close();
      })();
      return cleanupDone;
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

const pitchCmd = program.command("pitch").description("Pitch Scout proposals");
pitchCmd
  .command("promote <repo> <issue>")
  .description("Turn a pitch into owner-authored class:feature issues with your gh (prints every body and asks to confirm)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--slice <n>", "Promote only slice N, or several as a comma list such as 1,3 (default: every slice)")
  .option("--chain", "Make the created slices linear: each waits for the one before it to merge", false)
  .option("--yes", "Skip the confirmation prompt", false)
  .action(async (repo: string, issueArg: string, opts: { config?: string; slice?: string; chain?: boolean; yes?: boolean }) => {
    const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), repo);
    const paths = resolvePaths(cfg);
    const ledger = new Ledger(paths.ledgerDbPath, { repo: `${cfg.githubOwner}/${cfg.githubRepo}`, timeZone: cfg.dailyTimezone });
    try {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const created = await promotePitch(execRunner, ledger, {
          repo,
          issue: Number(issueArg),
          slice: opts.slice,
          chain: Boolean(opts.chain),
          yes: Boolean(opts.yes),
          labels: cfg.labels,
          confirm: async (q) => /^y(es)?$/i.test((await rl.question(q)).trim()),
          log: (s) => console.log(s),
        });
        console.log(`Promoted pitch #${issueArg} to ${created.map((n) => `#${n}`).join(", ")}.`);
      } finally {
        rl.close();
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    } finally {
      ledger.close();
    }
  });

program
  .command("gate")
  .description("Run the language-agnostic mechanical Gate against a git repository (always reads .pre-commit-config.yaml and .agents/archangel.json from the base commit)")
  .option("--repo <dir>", "Path to git repository (normal or bare)", ".")
  .requiredOption("--base <ref>", "Base commit/branch ref (e.g. main)")
  .option("--head <ref>", "Head commit/branch ref", "HEAD")
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
  .option("--smoke", "Also verify each configured subscription CLI is installed and logged in (no model calls)")
  .option("--json", "Output JSON")
  .action(async (opts: { config?: string; offline?: boolean; smoke?: boolean; json?: boolean }) => {
    const report = await runDoctor({ configPath: opts.config, offline: opts.offline, smoke: opts.smoke });
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
    const dataDir = resolveDataDir(opts);
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
    const dataDir = resolveDataDir(opts);
    const paths = resolvePaths({ dataDir });
    if (!fs.existsSync(paths.ledgerDbPath)) {
      const empty = { status: "no_ledger", message: `No Ledger found yet at ${paths.ledgerDbPath}. Run \`archangel start\` first.` };
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
      const now = Date.now();
      const grouped = groupThreads(threads, now);
      const health = computeHealth(ledger, now, repos);

      const payload = {
        health,
        spendTodayUsd: Number(spend.spentUsd.toFixed(4)),
        reservedUsd: Number(spend.reservedUsd.toFixed(4)),
        autoMergesToday,
        circuitBreakers: breakers,
        shadowModeStats: shadow,
        needsYou: threads.flatMap((t) =>
          t.phase.kind === "needs_you"
            ? [{ ...t, decisionClass: describeEscalation(t.phase.code).decisionClass, recommendation: describeEscalation(t.phase.code).recommendation }]
            : [],
        ),
        threads,
        stages: grouped.stages,
      };

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      for (const line of renderHealth(health)) console.log(line);
      console.log(`Spend today:      $${payload.spendTodayUsd.toFixed(2)} (reserved: $${payload.reservedUsd.toFixed(2)})`);
      console.log(`Auto-merges:      ${autoMergesToday}`);
      console.log(
        `Shadow agreement: ${shadow.agreed}/${shadow.total} (${Math.round(shadow.agreementRate * 100)}%)`,
      );
      for (const [r, b] of Object.entries(breakers)) {
        if (b.tripped) console.log(`Circuit breaker:  ${r} TRIPPED (${b.reason})`);
      }
      console.log("");
      if (payload.needsYou.length > 0) {
        console.log(`Needs You (${payload.needsYou.length}):`);
        for (const n of payload.needsYou) {
          console.log(`  ${n.repo}#${n.issueNumber}  [${formatDecisionClass(n.decisionClass)}]  ${n.title}`);
          console.log(`    Recommended: ${n.recommendation}`);
        }
        console.log("");
      }
      if (threads.length === 0) {
        console.log("No threads recorded in Ledger yet.");
        return;
      }
      for (const line of renderStages(grouped.stages, now)) console.log(line);
    } finally {
      ledger.close();
    }
  });

program
  .command("metrics")
  .description("Show factory funnel, latency percentiles, review outcomes, escalation breakdown, and active provider cooldowns")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--data-dir <dir>", "Archangel data directory")
  .option("--repo <owner/name>", "Filter by repository")
  .option("--days <n>", "Lookback window in days (default: all time)")
  .option("--json", "Output JSON")
  .action((opts: { config?: string; dataDir?: string; repo?: string; days?: string; json?: boolean }) => {
    const dataDir = resolveDataDir(opts);
    const paths = resolvePaths({ dataDir });
    if (!fs.existsSync(paths.ledgerDbPath)) {
      const empty = { message: `No Ledger found yet at ${paths.ledgerDbPath}. Run \`archangel start\` first.` };
      console.log(opts.json ? JSON.stringify(empty, null, 2) : empty.message);
      return;
    }
    const ledger = new Ledger(paths.ledgerDbPath, { readonly: true });
    try {
      const now = Date.now();
      const days = opts.days ? Number(opts.days) : null;
      const sinceMs = days && Number.isFinite(days) && days > 0 ? now - days * 86_400_000 : 0;
      const m = ledger.computeMetrics({ repo: opts.repo ?? null, sinceMs, now });
      if (opts.json) {
        console.log(JSON.stringify(m, null, 2));
        return;
      }
      console.log(`=== Archangel Metrics (${m.windowDays ? `last ${m.windowDays}d` : "all time"}${opts.repo ? `, ${opts.repo}` : ""}) ===`);
      console.log(`Threads:     ${m.threads.total} (${Object.entries(m.threads.byPhase).map(([k, v]) => `${k}=${v}`).join(", ") || "none"})`);
      console.log(`Lead time:   ${m.threads.avgLeadTimeSec !== null ? `${m.threads.avgLeadTimeSec}s avg` : "n/a"}`);
      console.log(
        `Attempts:    ${m.attempts.total} total (${m.attempts.succeeded} ok, ${m.attempts.failed} fail, ${m.attempts.aborted} abort; ${Math.round(m.attempts.successRate * 100)}% success)`,
      );
      for (const [role, r] of Object.entries(m.attempts.byRole).sort()) {
        const done = r.succeeded + r.failed + r.aborted;
        const models = Object.entries(r.models).map(([k, n]) => `${k} x${n}`).join(", ");
        console.log(
          `  ${role.padEnd(9)} ${r.attempts} attempts, ${done > 0 ? Math.round((r.succeeded / done) * 100) : 0}% ok, $${r.costUsd.toFixed(2)} metered${models ? ` (${models})` : ""}`,
        );
      }
      console.log(
        `Duration:    p50=${m.attempts.p50DurationSec ?? "n/a"}s, p95=${m.attempts.p95DurationSec ?? "n/a"}s; peak RSS p50=${m.attempts.p50PeakRssKb ?? "n/a"}KB, p95=${m.attempts.p95PeakRssKb ?? "n/a"}KB`,
      );
      console.log(
        `Shadow:      ${m.shadow.agreed}/${m.shadow.total} agreed (${Math.round(m.shadow.agreementRate * 100)}%)`,
      );
      const o = m.outcomes;
      const na = (n: number | null, unit = "") => (n === null ? "n/a" : `${n}${unit}`);
      console.log("Outcomes (merged fixes only; volume is not success):");
      console.log(`  Merged fixes: ${o.mergedFixes} (volume)`);
      console.log(
        `  Cost/fix:     ${o.costUsdPerFix === null ? "n/a" : `$${o.costUsdPerFix}`} metered (total $${o.meteredUsdTotal}; subscription runs count $0) | ${na(o.attemptsPerFix)} attempts/fix | ${na(o.attemptMinutesPerFix, "m")} attempt time/fix`,
      );
      console.log(`  Reverts/fix:  ${na(o.revertsPerFix)} (${o.reverts} reverted)`);
      console.log(`  Rework:       ${na(o.reworkAttemptsPerFix)} extra attempts/fix (${o.reworkAttemptsTotal} total)`);
      const corrections = correctionCategories(m.corrections).filter((c) => c.count > 0);
      console.log(`Owner corrections${m.corrections.windowDays ? ` (last ${m.corrections.windowDays}d)` : ""}: ${corrections.map((c) => `${c.category}=${c.count}`).join(", ") || "none"}`);
      console.log(
        `  Vendor agreement with owner: ${Object.entries(o.vendorAgreement).map(([v, s]) => `${v} ${s.rate === null ? "n/a" : `${Math.round(s.rate * 100)}%`} (${s.undisputed}/${s.approvedMerges})`).join(", ") || "n/a"}`,
      );
      console.log(
        `Reviews:     ${Object.entries(m.reviews.byVendor).map(([v, s]) => `${v}(+${s.approve}/-${s.veto})`).join(", ") || "none"} | outages=${m.reviews.outageEvents}`,
      );
      if (Object.keys(m.threads.escalationsByCode).length > 0) {
        console.log(
          `Escalations: ${Object.entries(m.threads.escalationsByCode).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        );
      }
      if (m.attempts.topErrors.length > 0) {
        console.log("Top attempt errors:");
        for (const e of m.attempts.topErrors) {
          console.log(`  - (${e.count}x) ${e.error}`);
        }
      }
      if (m.activeCooldowns.length > 0) {
        console.log("Active account cooldowns:");
        for (const c of m.activeCooldowns) {
          const remMin = Math.max(1, Math.ceil((c.untilTs - now) / 60_000));
          console.log(`  - ${c.account}: ${remMin}m left (${c.reason})`);
        }
      }
      const signals: string[] = [];
      for (const e of m.attempts.topErrors) {
        if (e.count >= 2) signals.push(`repeated attempt error (${e.count}x): ${e.error}`);
      }
      if (m.reviews.outageEvents >= 2) {
        signals.push(`repeated review outages (${m.reviews.outageEvents}x) — check provider CLIs with \`archangel doctor\``);
      }
      for (const [code, cnt] of Object.entries(m.threads.escalationsByCode)) {
        signals.push(`open needs_you escalation (${cnt}x): ${code}`);
      }
      if (signals.length > 0) {
        console.log("Actionable signals:");
        for (const s of signals) console.log(`  ! ${s}`);
      }
    } finally {
      ledger.close();
    }
  });

program
  .command("gate-bump")
  .description("Open one PR per watched repo whose Gate workflow pin or template has drifted, with your gh CLI (never merged by this command)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--repo <owner/name>", "Only this repo")
  .option("--all", "Every project in archangel.yaml")
  .option("--dry-run", "Report drift and change nothing")
  .action(async (opts: { config?: string; repo?: string; all?: boolean; dryRun?: boolean }) => {
    if (!opts.repo === !opts.all) throw new Error("Pass exactly one of --repo <owner/name> or --all");
    const repos = opts.repo
      ? [opts.repo]
      : loadProjectConfigs({ configPath: opts.config }).map((c) => `${c.githubOwner}/${c.githubRepo}`);
    await gateBump(execRunner, repos, { dryRun: opts.dryRun });
  });

const workflowCmd = program.command("workflow").description("Propose changes to a repo's workflow file (.agents/archangel.json)");

workflowCmd
  .command("propose <repo>")
  .description("Validate a workflow file and open ONE PR with it (labelled policy:loosens if it loosens a limit), with your gh CLI; never merged")
  .requiredOption("--file <path>", "Proposed .agents/archangel.json")
  .option("--prompts <dir>", "Directory with <scout>.md prompt bodies (default: <file dir>/scouts)")
  .option("--base-sha <sha256>", "sha256 of the current file the draft was based on; refuses if main's file differs (use empty string for 'no file')")
  .option("-c, --config <path>", "Path to archangel.yaml (adds the effective landing mode to the PR body)")
  .option("--dry-run", "Print the plan and change nothing")
  .action(async (repo: string, opts: { file: string; prompts?: string; baseSha?: string; config?: string; dryRun?: boolean }) => {
    const proposedRaw = fs.readFileSync(opts.file, "utf8");
    const promptsDir = path.resolve(opts.prompts ?? path.join(path.dirname(opts.file), "scouts"));
    const scoutPrompts: Record<string, string> = {};
    const names = (() => {
      const parsed = tryParseJson(proposedRaw);
      if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) return [];
      const scouts = (parsed.value as { scouts?: Array<{ name?: unknown }> }).scouts;
      return Array.isArray(scouts) ? scouts.map((s) => s?.name) : [];
    })();
    for (const name of names) {
      if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,48}$/.test(name)) continue;
      const f = path.join(promptsDir, `${name}.md`);
      if (fs.existsSync(f)) scoutPrompts[name] = fs.readFileSync(f, "utf8");
    }
    const cfg = opts.config
      ? loadProjectConfigs({ configPath: opts.config }).find((c) => `${c.githubOwner}/${c.githubRepo}` === repo)
      : undefined;
    await proposeWorkflow(execRunner, repo, proposedRaw, {
      baseFileSha256: opts.baseSha,
      scoutPrompts,
      dryRun: opts.dryRun,
      host: cfg && {
        shadowMode: cfg.shadowMode,
        maxAutoMergesPerDay: cfg.maxAutoMergesPerDay,
        maxAutoPromotionsPerDay: cfg.scouts.maxAutoPromotionsPerDay,
        scoutRunsPerDay: cfg.scouts.maxRunsPerDay,
        scoutsEnabled: cfg.scouts.enabled,
        maxConcurrentThreads: cfg.maxConcurrentThreads,
        factoryRetry: cfg.factoryRetry,
        fleetScouts: cfg.fleetScouts,
        isRevoked: () => false,
      },
    });
  });

program
  .command("replay")
  .description("Re-run the Gate offline over captured Threads and seeded corruptions of known-good fixes; exits 1 on any regression (local only, no GitHub, no model)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--data-dir <dir>", "Archangel data directory")
  .option("--repo <owner/name>", "Only this repository (default: every repository in the Ledger)")
  .option("--since <days>", "Only Threads updated in the last N days")
  .option("--run-tests", "Also run the repo's test commands (full Gate on good fixes, and the mutants only tests can catch). Executes repo code on this machine.")
  .option("--json", "Output JSON")
  .action(async (opts: { config?: string; dataDir?: string; repo?: string; since?: string; runTests?: boolean; json?: boolean }) => {
    const dataDir = resolveDataDir(opts);
    const root = resolvePaths({ dataDir });
    if (!fs.existsSync(root.ledgerDbPath)) {
      console.log(`No Ledger found yet at ${root.ledgerDbPath}. Run \`archangel start\` first.`);
      return;
    }
    const ledger = new Ledger(root.ledgerDbPath, { readonly: true });
    try {
      const days = opts.since ? Number(opts.since) : 0;
      const sinceMs = days > 0 ? Date.now() - days * 86_400_000 : 0;
      const repos = opts.repo ? [opts.repo] : [...new Set(ledger.listAllThreads().map((t) => t.repo))].sort();
      const reports: ReplayReport[] = [];
      for (const repo of repos) {
        const [githubOwner, githubRepo] = repo.split("/") as [string, string];
        const bareRepoPath = resolvePaths({ dataDir, githubOwner, githubRepo }).brokerBareRepoPath;
        if (!fs.existsSync(bareRepoPath)) {
          console.error(`skipping ${repo}: no broker repo at ${bareRepoPath}`);
          continue;
        }
        reports.push(await runReplay({ repo, bareRepoPath, seeds: ledger.listReplaySeeds(sinceMs, repo), runTests: opts.runTests }));
      }
      if (reports.length > 0) saveReport(dataDir, "replay", reports);
      if (opts.json) console.log(JSON.stringify(reports, null, 2));
      else for (const r of reports) console.log(renderReplay(r));
      if (reports.some((r) => r.regressions > 0)) process.exit(1);
    } finally {
      ledger.close();
    }
  });

const evalCmd = program.command("eval").description("Offline review eval: score a candidate prompt/rubric change against captured, labelled cases (never lands anything)");

/** Every repo in the Ledger with a Broker repo on disk, as eval sources. */
function evalSources(ledger: Ledger, dataDir: string, only?: string) {
  const repos = only ? [only] : [...new Set(ledger.listAllThreads().map((t) => t.repo))].sort();
  return repos.flatMap((repo) => {
    const [githubOwner, githubRepo] = repo.split("/") as [string, string];
    const bareRepoPath = resolvePaths({ dataDir, githubOwner, githubRepo }).brokerBareRepoPath;
    if (!fs.existsSync(bareRepoPath)) {
      console.error(`skipping ${repo}: no broker repo at ${bareRepoPath}`);
      return [];
    }
    return [{ repo, bareRepoPath, seeds: ledger.listReplaySeeds(0, repo), attemptInputs: ledger.listAttemptInputs(repo) }];
  });
}

evalCmd
  .command("status")
  .description("Show the vault's case counts against the calibration milestones (no model calls)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--data-dir <dir>", "Archangel data directory")
  .option("--repo <owner/name>", "Only this repository")
  .action(async (opts: { config?: string; dataDir?: string; repo?: string }) => {
    const dataDir = resolveDataDir(opts);
    const root = resolvePaths({ dataDir });
    if (!fs.existsSync(root.ledgerDbPath)) return void console.log(`No Ledger found yet at ${root.ledgerDbPath}. Run \`archangel start\` first.`);
    const ledger = new Ledger(root.ledgerDbPath);
    try {
      const { cases, skipped } = await collectEvalCases(ledger, evalSources(ledger, dataDir, opts.repo));
      const counts = {
        total: cases.length, dev: cases.filter((c) => c.split === "dev").length, heldout: cases.filter((c) => c.split === "heldout").length,
        good: cases.filter((c) => c.label === "good").length, bad: cases.filter((c) => c.label === "bad").length,
        disputes: cases.filter((c) => c.dispute).length, mutants: cases.filter((c) => c.kind === "mutant").length,
        unreplayable: skipped, withoutIssueText: cases.filter((c) => c.body === null).length,
      };
      for (const line of renderCounts({ counts, milestones: milestoneProgress(cases.length) })) console.log(line);
      if (cases.length < EVAL_THRESHOLDS.minCases) console.log(`INSUFFICIENT DATA: ${EVAL_THRESHOLDS.minCases} replayable cases are needed before \`eval run\` can score anything.`);
    } finally {
      ledger.close();
    }
  });

evalCmd
  .command("run")
  .description("Score a candidate patch (src/agents/prompts.ts, skills/*.md, .agents/archangel.json) against the baseline with real reviewer CLIs. Exit 0 pass, 1 fail, 2 insufficient data")
  .requiredOption("--candidate <patch>", "A git patch file, applied to a throwaway checkout of Archangel's HEAD")
  .option("-c, --config <path>", "Path to archangel.yaml (reviewer chain)")
  .option("--data-dir <dir>", "Archangel data directory")
  .option("--repo <owner/name>", "Only this repository")
  .option("--heldout", "Score the held-out set (default: the dev set)")
  .option("--max-cases <n>", `Cap on cases per run (default ${EVAL_THRESHOLDS.defaultMaxCases}); each case costs reviewer calls`)
  .option("--json", "Output JSON")
  .action(async (opts: { candidate: string; config?: string; dataDir?: string; repo?: string; heldout?: boolean; maxCases?: string; json?: boolean }) => {
    const host = resolveHostSettings(opts);
    if (host.authMode !== "subscription") throw new Error("eval uses the subscription reviewer CLIs; set authMode: subscription");
    const dataDir = host.dataDir;
    const root = resolvePaths({ dataDir });
    if (!fs.existsSync(root.ledgerDbPath)) return void console.log(`No Ledger found yet at ${root.ledgerDbPath}. Run \`archangel start\` first.`);
    const maxCases = opts.maxCases === undefined ? undefined : Number(opts.maxCases);
    if (maxCases !== undefined && !(Number.isInteger(maxCases) && maxCases >= 1)) throw new Error("--max-cases must be an integer >= 1");
    const ledger = new Ledger(root.ledgerDbPath);
    const { baseline, candidate } = await prepareCandidates(ARCHANGEL_ROOT, opts.candidate);
    try {
      const report = await runEval({
        ledger,
        sources: evalSources(ledger, dataDir, opts.repo),
        suiteFor: (prompts) => new SubscriptionReviewerSuite({ chain: host.reviewerChain, defaultExcludeVendors: primaryWriterVendors(host.chains), prompts }),
        baseline: baseline.prompts,
        candidate,
        heldout: opts.heldout,
        maxCases,
      });
      saveReport(dataDir, "eval", report);
      console.log(opts.json ? JSON.stringify(report, null, 2) : renderEval(report));
      process.exitCode = report.result === "pass" ? 0 : report.result === "fail" ? 1 : 2;
    } finally {
      candidate.cleanup();
      ledger.close();
    }
  });

evalCmd
  .command("bench-tiers")
  .description("Benchmark a candidate provider chain against the current one on captured implementation cases, scored mechanically by the Gate. Makes real subscription CLI calls; never edits archangel.yaml")
  .requiredOption("--role <role>", "implement | revise | rebase")
  .requiredOption("--candidate-chain <chain>", "provider[:model],... e.g. codex:gpt-5-mini,agy")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--data-dir <dir>", "Archangel data directory")
  .option("--repo <owner/name>", "Only this repository")
  .option("--max-cases <n>", `Cap on cases (default ${BENCH.defaultMaxCases}); each case runs a real implementer on both chains`)
  .option("--run-tests", "Score with the Gate's tests (red on base, green on head); default is the static Gate")
  .option("--json", "Output JSON")
  .action(async (opts: { role: string; candidateChain: string; config?: string; dataDir?: string; repo?: string; maxCases?: string; runTests?: boolean; json?: boolean }) => {
    if (!(WRITER_ROLES as readonly string[]).includes(opts.role)) throw new Error(`--role must be one of ${WRITER_ROLES.join(", ")}`);
    const role = opts.role as WriterRole;
    const host = resolveHostSettings(opts);
    if (host.authMode !== "subscription") throw new Error("bench-tiers uses the subscription CLIs; set authMode: subscription");
    const root = resolvePaths({ dataDir: host.dataDir });
    if (!fs.existsSync(root.ledgerDbPath)) return void console.log(`No Ledger found yet at ${root.ledgerDbPath}. Run \`archangel start\` first.`);
    const maxCases = opts.maxCases === undefined ? undefined : Number(opts.maxCases);
    if (maxCases !== undefined && !(Number.isInteger(maxCases) && maxCases >= 1)) throw new Error("--max-cases must be an integer >= 1");
    const candidateChain = parseChain(opts.candidateChain);
    const ledger = new Ledger(root.ledgerDbPath);
    try {
      const report = await runBenchTiers({
        ledger,
        sources: evalSources(ledger, host.dataDir, opts.repo),
        role,
        currentChain: host.chains[role],
        candidateChain,
        implementerFor: (chain) => new SubscriptionImplementer({ chains: { implement: chain, revise: chain, rebase: chain }, transcriptsDir: path.join(root.dataDir, "bench-transcripts") }),
        runTests: opts.runTests,
        maxCases,
      });
      saveReport(host.dataDir, "bench-tiers", report);
      console.log(opts.json ? JSON.stringify(report, null, 2) : renderBench(report));
      process.exitCode = report.verdict === "insufficient" ? 2 : report.verdict === "worse" ? 1 : 0;
    } finally {
      ledger.close();
    }
  });

program
  .command("onboard <repo>")
  .description("Do the GitHub plumbing for a new repo with your gh CLI: labels and one onboarding PR (never merged by this command)")
  .option("--dry-run", "Print the plan and change nothing")
  .action(async (repo: string, opts: { dryRun?: boolean }) => {
    await onboard(execRunner, repo, { dryRun: opts.dryRun });
  });

program
  .command("bump <repo> [pkgs...]")
  .description("Bump a repo's dependencies in a throwaway clone with install scripts disabled, audit, run its testCmd, and open an owner-authored PR (never merged; never run by the daemon)")
  .option("--patch", "Patch releases only for direct dependencies (the default)")
  .option("--minor", "Allow minor releases")
  .option("--yes", "Skip the confirmation prompt", false)
  .action(async (repo: string, pkgs: string[], opts: { patch?: boolean; minor?: boolean; yes?: boolean }) => {
    try {
      if (opts.patch && opts.minor) throw new Error("Choose --patch or --minor, not both.");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const url = await bump(bumpRunner, {
          repo,
          level: opts.minor ? "minor" : "patch",
          pkgs,
          yes: Boolean(opts.yes),
          confirm: async (q) => /^y(es)?$/i.test((await rl.question(q)).trim()),
          log: (s) => console.log(s),
        });
        console.log(`Opened ${url}`);
      } finally {
        rl.close();
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command("preview <ref>")
  .description("RUNNER ONLY: serve a local git ref in a macOS sandbox on a loopback URL (no PoC build, no Ledger row; Ctrl-C, the 60 min TTL or 15 min idle stops it)")
  .requiredOption("--start <command>", "The command that starts the app; it gets PORT and HOST=127.0.0.1")
  .option("--repo <dir>", "The repository holding <ref>", process.cwd())
  .option("--ready-path <path>", "Polled for up to 30 s before the URL is printed", "/")
  .option("--ui-port <n>", "The dashboard port, which a preview never uses", "4477")
  .action(async (ref: string, opts: { start: string; repo: string; readyPath: string; uiPort: string }) => {
    const [cmd, ...args] = opts.start.trim().split(/\s+/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-preview-ws-"));
    const provider = new SandboxExecProvider({ prepare: async () => ({ id: dir, path: dir }), collect: async () => ({ kind: "clone", path: dir }), destroy: () => undefined }, { reservedPorts: [Number(opts.uiPort)] });
    try {
      await execFileGroup("git", ["init", "--quiet", dir]);
      await execFileGroup("git", ["fetch", "--quiet", path.resolve(opts.repo), ref], { cwd: dir });
      await execFileGroup("git", ["checkout", "--quiet", "FETCH_HEAD"], { cwd: dir });
      // Installs never run here: Seatbelt cannot allow registry hosts for one step, so dependencies must come from the ref.
      const preview = await provider.expose({ id: dir, path: dir }, { port: 0, ttlMs: 60 * 60_000, cmd: cmd!, args, readyPath: opts.readyPath });
      process.once("SIGINT", preview.close);
      process.once("SIGTERM", preview.close);
      console.log(`Preview of ${ref}: ${preview.url}  (sandboxed, loopback only; Ctrl-C to stop)`);
      await preview.closed;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

program
  .command("ui")
  .description("Serve a local dashboard from the Ledger; its only write is a guarded POST that opens an unmerged workflow PR with your gh (disabled with --allow-remote)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--data-dir <dir>", "Archangel data directory")
  .option("--port <n>", "Port", "4477")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--allow-remote", "Allow binding a non-loopback host (the page has no authentication)")
  .action(async (opts: { config?: string; dataDir?: string; port: string; host: string; allowRemote?: boolean }) => {
    assertBindable(opts.host, Boolean(opts.allowRemote));
    const paths = resolvePaths({ dataDir: resolveDataDir(opts) });
    // The Ledger belongs to the daemon: the UI never creates or writes it. Before the first `archangel start` it serves an
    // empty in-memory stand-in, and switches to the real file (read-only) as soon as the daemon has created it.
    let real: Ledger | null = null;
    let standIn: Ledger | null = null;
    const ledger = (): Ledger => {
      if (real) return real;
      if (fs.existsSync(paths.ledgerDbPath)) {
        real = new Ledger(paths.ledgerDbPath, { readonly: true });
        standIn?.close();
        return real;
      }
      return (standIn ??= new Ledger(":memory:"));
    };
    const appender = (source: string) => (topic: string, payload: Record<string, unknown>, now: number) => {
      // Audit-before-write: with no Ledger there is nowhere to record it, and the UI must not create one, so refuse.
      if (!fs.existsSync(paths.ledgerDbPath)) throw new Error("The daemon has not run yet, so there is no Ledger to record this in. Run `archangel init`, then retry.");
      const w = new Ledger(paths.ledgerDbPath);
      try { w.appendAudit(topic, null, source, payload, now, null); } finally { w.close(); }
    };
    await startUiServer(ledger, { host: opts.host, port: Number(opts.port), allowRemote: opts.allowRemote, proposeRunner: execRunner, configPath: opts.config, dataDir: paths.dataDir, hostConfig: { configPath: resolveConfigPath(opts.config), audit: appender("host_config") }, onboardAudit: appender("ui_onboard"), ledgerMissing: () => real === null, doctor: ({ scope, smoke }) => runDoctor({ configPath: opts.config, offline: scope === "machine", smoke }) });
    console.log(`Archangel UI: http://${opts.host.includes(":") ? `[${opts.host}]` : opts.host}:${opts.port}`);
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
    const dataDir = resolveDataDir(opts);
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
      ledger.appendAudit("thread/owner_resumed", Number(issueArg), "owner", {});
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
  .option("-m, --message <text>", "Guidance for the next Attempt (added to the prompt as owner text)")
  .action(async (issueArg: string, opts: { config?: string; repo?: string; message?: string }) => {
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
      const now = Date.now();
      const stepped = stepPhase(
        thread.phase,
        thread.mode,
        { t: "owner_retry", now },
        { issueNumber, title: thread.title, needsYouLabel: cfg.labels.needsYou },
      );
      if (!stepped.ok) throw new Error(stepped.reject);
      const reply = await collectOwnerReply({
        github,
        ownerUserId: cfg.ownerUserId,
        issueNumber,
        prNumber: extractPrFromPhase(thread.phase)?.prNumber ?? null,
        sinceMs: thread.updatedAt,
        message: opts.message,
      });
      await github.removeLabel(issueNumber, cfg.labels.needsYou);
      requireTransition(
        ledger.transition(issueNumber, thread.version, stepped.next, {
          bodySha256: sha256(issue.body),
          ownerReply: reply ?? undefined,
          grantRetryBudget: true,
          auditTopic: "thread/owner_retried",
          extraAudits: [
            {
              topic: "thread/owner_retry",
              actor: "owner",
              payload: { via: "cli", code: thread.phase.kind === "needs_you" ? thread.phase.code : null },
            },
          ],
          now,
        }),
        repoSlug,
        issueNumber,
      );
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
      requireTransition(
        ledger.transition(issueNumber, thread.version, stepped.next, { auditTopic: "thread/owner_abandoned" }),
        repoSlug,
        issueNumber,
      );
      console.log(`Abandoned ${repoSlug}#${issueNumber}.`);
    } finally {
      ledger.close();
    }
  });

program
  .command("disagree <issue>")
  .description("Record an owner disagreement with a merge, shadow or autonomous (marks factory:disagree on GitHub + Ledger)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--repo <owner/name>", "Target repository")
  .action(async (issueArg: string, opts: { config?: string; repo?: string }) => {
    const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), opts.repo);
    const repoSlug = `${cfg.githubOwner}/${cfg.githubRepo}`;
    const paths = resolvePaths(cfg);
    const ledger = new Ledger(paths.ledgerDbPath, { repo: repoSlug, timeZone: cfg.dailyTimezone });
    try {
      const issueNumber = Number(issueArg);
      if (ledger.markDisagree(issueNumber, true) === 0) {
        throw new Error(`No merge recorded for ${repoSlug}#${issueNumber}; nothing to disagree with.`);
      }
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
  .option("--repo <owner/name>", "Target repository")
  .action((opts: { config?: string; dataDir?: string; repo?: string }) => {
    const repo =
      opts.repo ??
      (() => {
        const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }));
        return `${cfg.githubOwner}/${cfg.githubRepo}`;
      })();
    const dataDir = resolveDataDir(opts);
    const paths = resolvePaths({ dataDir });
    const ledger = new Ledger(paths.ledgerDbPath, { repo });
    try {
      ledger.setCircuitBreaker(false, "manually reset by owner");
      console.log(`Circuit breaker reset for ${repo}.`);
    } finally {
      ledger.close();
    }
  });

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const LAUNCHD_LABEL = "com.archangel.daemon";
function launchdPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

const daemonCmd = program
  .command("daemon")
  .description("Manage the always-on macOS launchd user agent (fixed checkout, no secrets in plist)");

daemonCmd
  .command("install")
  .description("Write and load ~/Library/LaunchAgents/com.archangel.daemon.plist")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .action((opts: { config?: string }) => {
    if (process.platform !== "darwin") {
      throw new Error("`archangel daemon install` currently supports macOS (launchd) only.");
    }
    const workDir = process.cwd();
    const entryTs = path.resolve(workDir, "src/cli/index.ts");
    if (!fs.existsSync(entryTs)) {
      throw new Error(`CLI entry not found at ${entryTs}. Run \`daemon install\` from the Archangel checkout.`);
    }
    const configPath = path.resolve(workDir, opts.config ?? "archangel.yaml");
    const logDir = path.resolve(workDir, ".archangel");
    fs.mkdirSync(logDir, { recursive: true });
    const plistPath = launchdPlistPath();
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });

    // Capture current PATH so launchd can locate bun, git, go, codex, claude, and agy.
    // Never write secrets into the plist; Archangel loads `.env` (chmod 600) at runtime.
    const capturedPath = process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    const args = [process.execPath, entryTs, "start", "--config", configPath];

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workDir)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(capturedPath)}</string>
    <key>HOME</key>
    <string>${escapeXml(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, "daemon.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, "daemon.err.log"))}</string>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plist, { encoding: "utf8", mode: 0o600 });
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
    } catch (_err) {
      // launchctl bootout exits non-zero when the agent is not currently loaded.
      void _err;
    }
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "inherit" });
    console.log(`Installed & loaded ${LAUNCHD_LABEL} (${plistPath}).`);
    console.log(`Logs: ${path.join(logDir, "daemon.log")} and ${path.join(logDir, "daemon.err.log")}`);
  });

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

daemonCmd
  .command("restart")
  .description("Restart the loaded launchd agent (SIGTERM, wait for the Ledger lock to be released, kickstart)")
  .action(() => {
    if (process.platform !== "darwin") {
      throw new Error("`archangel daemon restart` currently supports macOS (launchd) only.");
    }
    const target = `gui/${process.getuid!()}/${LAUNCHD_LABEL}`;
    let printed: string;
    try {
      printed = execFileSync("launchctl", ["print", target], { encoding: "utf8" });
    } catch (err) {
      throw new Error(`${LAUNCHD_LABEL} is not loaded in launchd (${err instanceof Error ? err.message : String(err)}). Run \`archangel daemon install\` first.`);
    }
    // `kickstart -k` SIGKILLs after launchd's 20 s ExitTimeOut, and a daemon killed mid-shutdown never releases the Ledger
    // lock: the new one then exits "Another live daemon" and KeepAlive respawns it until the lease goes stale. Instead
    // stop it gently, wait for the old process to exit (which is when it has released the lock), then start it.
    const pidMatch = printed.match(/^\s*pid = (\d+)/m);
    if (pidMatch) {
      const pid = Number(pidMatch[1]);
      execFileSync("launchctl", ["kill", "SIGTERM", target], { stdio: "inherit" });
      const deadline = Date.now() + 30_000;
      while (isProcessAlive(pid)) {
        if (Date.now() > deadline) {
          throw new Error(`Daemon pid ${pid} is still running 30 s after SIGTERM and still holds the Ledger lock; not starting a second one. Stop it by hand, then retry.`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
    execFileSync("launchctl", ["kickstart", target], { stdio: "inherit" });
    console.log(`Restarted ${LAUNCHD_LABEL}.`);
  });

daemonCmd
  .command("uninstall")
  .description("Unload and remove ~/Library/LaunchAgents/com.archangel.daemon.plist")
  .action(() => {
    if (process.platform !== "darwin") {
      throw new Error("`archangel daemon uninstall` currently supports macOS (launchd) only.");
    }
    const plistPath = launchdPlistPath();
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
    } catch (_err) {
      // launchctl bootout exits non-zero when the agent is already unloaded.
      void _err;
    }
    if (fs.existsSync(plistPath)) {
      fs.rmSync(plistPath);
      console.log(`Unloaded & removed ${plistPath}.`);
    } else {
      console.log(`${plistPath} not present.`);
    }
  });

daemonCmd
  .command("status")
  .description("Show macOS launchd daemon status")
  .action(() => {
    const plistPath = launchdPlistPath();
    console.log(`Plist: ${plistPath} (${fs.existsSync(plistPath) ? "installed" : "not installed"})`);
    if (process.platform === "darwin") {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      try {
        const out = execFileSync("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stateLine = out.split("\n").find((l) => l.includes("state =") || l.includes("pid ="));
        console.log(stateLine?.trim() ?? "Loaded");
      } catch (_err) {
        console.log("Not loaded in launchd.");
      }
    }
  });

const scoutCmd = program
  .command("scout")
  .description("Run the read-only Scouts declared in the repo workflow file (.agents/archangel.json)");

scoutCmd
  .command("skills")
  .description("List bundled Scout skills (reference them from a Scout's `skills` list in .agents/archangel.json)")
  .action(() => {
    for (const ref of listAllSkills()) console.log(ref);
  });

scoutCmd
  .command("run [name]")
  .description("Run repo-owned Scout workflow(s) against the default branch (or --dry-run to list them)")
  .option("-c, --config <path>", "Path to archangel.yaml")
  .option("--repo <owner/name>", "Target repository")
  .option("--dry-run", "List declared Scouts without running CLIs", false)
  .action(async (name: string | undefined, opts: { config?: string; repo?: string; dryRun?: boolean }) => {
    const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), opts.repo);
    const repoSlug = `${cfg.githubOwner}/${cfg.githubRepo}`;
    const paths = resolvePaths(cfg);
    const logger = new ArchangelLogger({
      logFilePath: path.join(paths.dataDir, "archangel.log.jsonl"),
      consoleOutput: true,
    });
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
      const remoteUrl = await github.getRemoteUrlWithToken();
      await broker.ensureBareRepo(remoteUrl);
      const mainSha = await broker.resolveRef(`refs/heads/${cfg.defaultBranch}`);

      const workflow = requireOkWorkflow(await loadWorkflow(broker, cfg, ledger, mainSha));
      const summaries = await runScoutsForProject({
        config: cfg,
        ledger,
        github,
        broker,
        workflow,
        reviewers: makeReviewerSuite(cfg, paths.mastraDbPath, ledger),
        notifier: new TelegramNotifier({ botToken: cfg.telegramBotToken, chatId: cfg.telegramChatId }),
        mainSha,
        filterName: name,
        dryRun: Boolean(opts.dryRun),
        logger,
      });
      if (summaries.length === 0) {
        console.log(`No matching Scouts declared on ${repoSlug}@${mainSha.slice(0, 8)}.`);
        return;
      }
      for (const s of summaries) {
        if (s.status === "dry_run") {
          console.log(`[dry-run] ${repoSlug}: scout '${s.scoutName}'`);
        } else {
          console.log(
            `[${s.status}] ${repoSlug} scout '${s.scoutName}': filed=${s.filedIssues.map((n) => `#${n}`).join(",") || "none"}, deduped=${s.skippedDuplicates}, secrets_blocked=${s.blockedSecrets}`,
          );
        }
      }
    } finally {
      ledger.close();
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
