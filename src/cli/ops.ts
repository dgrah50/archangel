import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import type { Command } from "commander";
import { tryParseJson } from "../core/json.js";
import { loadProjectConfigs, resolveConfigPath, resolvePaths } from "../config.js";
import { GitBroker } from "../broker/git-broker.js";
import { runDoctor } from "../core/doctor.js";
import { ArchangelLogger } from "../core/logger.js";
import { gateBump } from "../core/gate-pin.js";
import { proposeWorkflow } from "../core/workflow-propose.js";
import { execRunner, onboard } from "../core/onboard.js";
import { bump, bumpRunner } from "../core/bump.js";
import { TelegramNotifier } from "../core/notifier.js";
import { assertBindable, startUiServer } from "../core/ui-server.js";
import { runScoutsForProject } from "../core/scout.js";
import { ownerFix } from "../core/self-build.js";
import { SubscriptionImplementer } from "../agents/subscription-implementer.js";
import { SandboxExecProvider } from "../compute/sandbox-exec.js";
import { execFileGroup } from "../core/spawn-group.js";
import { loadWorkflow, requireOkWorkflow } from "../core/workflow-load.js";
import { listAllSkills } from "../core/skills.js";
import { runGate } from "../gate/gate.js";
import { GitHubAppClient } from "../github/client.js";
import { Ledger } from "../ledger/store.js";
import { resolveDataDir, resolveUiSettings } from "./data-dir.js";
import { INIT_NEXT_STEPS, runInit } from "./init.js";
import { makeReviewerSuite, pickProjectConfig } from "./shared.js";

export function registerOps(program: Command): void {
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
    .option("--verify-setup", "Also dry-run each repo's .agents/setup from main in a throwaway clone (sandboxed on macOS)")
    .option("--json", "Output JSON")
    .action(async (opts: { config?: string; offline?: boolean; smoke?: boolean; verifySetup?: boolean; json?: boolean }) => {
      const report = await runDoctor({ configPath: opts.config, offline: opts.offline, smoke: opts.smoke, verifySetup: opts.verifySetup });
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
    .option("--port <n>", "Port (default: ui.port in archangel.yaml, else 4477)")
    .option("--host <host>", "Host to bind (default: ui.host in archangel.yaml, else 127.0.0.1)")
    .option("--allow-remote", "Allow binding a non-loopback host (the page has no authentication)")
    .action(async (flags: { config?: string; dataDir?: string; port?: string; host?: string; allowRemote?: boolean }) => {
      const opts = { ...flags, ...resolveUiSettings(flags) };
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
    .command("fix <repo> <issue>")
    .description("Build the fix for a Scout's bug proposal here with the implementer (it may edit protected paths), show the diff, and open an owner-authored PR on selfbuild/* that you merge yourself")
    .option("-c, --config <path>", "Path to archangel.yaml")
    .option("--yes", "Skip the confirmation prompt", false)
    .action(async (repo: string, issueArg: string, opts: { config?: string; yes?: boolean }) => {
      const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), repo);
      const paths = resolvePaths(cfg);
      const ledger = new Ledger(paths.ledgerDbPath, { repo, timeZone: cfg.dailyTimezone });
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const url = await ownerFix(execRunner, ledger, {
          repo,
          issue: Number(issueArg),
          yes: Boolean(opts.yes),
          cfg,
          implementer: new SubscriptionImplementer({ chains: cfg.chains, accounts: cfg.accounts, transcriptsDir: paths.transcriptsDir }),
          confirm: async (q) => /^y(es)?$/i.test((await rl.question(q)).trim()),
          log: (line) => console.log(line),
        });
        console.log(`Opened ${url}. Merging it is up to you; Archangel never merges it.`);
      } finally {
        rl.close();
        ledger.close();
      }
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
          reviewers: makeReviewerSuite(cfg, ledger),
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
}
