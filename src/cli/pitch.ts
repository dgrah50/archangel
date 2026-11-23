import readline from "node:readline/promises";
import type { Command } from "commander";
import { loadProjectConfigs, resolvePaths } from "../config.js";
import { SubscriptionImplementer } from "../agents/subscription-implementer.js";
import { GitBroker } from "../broker/git-broker.js";
import { execRunner } from "../core/onboard.js";
import { cachedWebPreview, startPocPreview } from "../core/pitch-preview.js";
import { promotePitch } from "../core/pitch-promote.js";
import { selfBuild } from "../core/self-build.js";
import { LocalProvider } from "../compute/local.js";
import { SandboxExecProvider } from "../compute/sandbox-exec.js";
import { GitHubAppClient } from "../github/client.js";
import { Ledger } from "../ledger/store.js";
import { pickProjectConfig } from "./shared.js";

export function registerPitch(program: Command): void {
  const pitchCmd = program.command("pitch").description("Pitch Scout proposals");
  pitchCmd
    .command("promote <repo> <issue>")
    .description("Turn a pitch into owner-authored class:feature issues with your gh (prints every body and asks to confirm)")
    .option("-c, --config <path>", "Path to archangel.yaml")
    .option("--slice <n>", "Promote only slice N, or several as a comma list such as 1,3 (default: every slice)")
    .option("--chain", "Make the created slices linear: each waits for the one before it to merge", false)
    .option("--build", "Instead of opening a daemon issue, build ONE slice here (needs --slice) with the implementer, show the diff, and open an owner-authored PR on selfbuild/* that you merge yourself", false)
    .option("--yes", "Skip the confirmation prompt", false)
    .action(async (repo: string, issueArg: string, opts: { config?: string; slice?: string; chain?: boolean; build?: boolean; yes?: boolean }) => {
      const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), repo);
      const paths = resolvePaths(cfg);
      const ledger = new Ledger(paths.ledgerDbPath, { repo: `${cfg.githubOwner}/${cfg.githubRepo}`, timeZone: cfg.dailyTimezone });
      try {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          if (opts.build) {
            if (!opts.slice) throw new Error("--build needs --slice <n>");
            if (opts.chain) throw new Error("--build cannot be combined with --chain");
            const url = await selfBuild(execRunner, ledger, {
              repo,
              issue: Number(issueArg),
              slice: opts.slice,
              yes: Boolean(opts.yes),
              labels: cfg.labels,
              cfg,
              implementer: new SubscriptionImplementer({ chains: cfg.chains, accounts: cfg.accounts, transcriptsDir: paths.transcriptsDir }),
              confirm: async (q) => /^y(es)?$/i.test((await rl.question(q)).trim()),
              log: (s) => console.log(s),
            });
            console.log(`Opened ${url}. Merging it is up to you; Archangel never merges it.`);
            return;
          }
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

  pitchCmd
    .command("poc <repo> <issue>")
    .description("Ask the daemon to build a throwaway proof of concept of a pitch (kept as a local ref, never pushed; at most 2 per pitch and 2 a day)")
    .option("-c, --config <path>", "Path to archangel.yaml")
    .action((repo: string, issueArg: string, opts: { config?: string }) => {
      const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), repo);
      const ledger = new Ledger(resolvePaths(cfg).ledgerDbPath, { repo: `${cfg.githubOwner}/${cfg.githubRepo}`, timeZone: cfg.dailyTimezone });
      try {
        const res = ledger.reservePocBuild(Number(issueArg));
        if (!res.ok) {
          console.error(`No build started: ${res.reason}.`);
          process.exit(1);
        }
        console.log(`Build queued for pitch #${issueArg}. The daemon starts it on its next pass (it uses your subscription once).`);
      } finally {
        ledger.close();
      }
    });

  pitchCmd
    .command("preview <repo> <issue>")
    .description("Run a built PoC in a macOS sandbox on a loopback URL and screenshot it (installed at build time; 60 min TTL, 15 min idle; Ctrl-C stops it)")
    .option("-c, --config <path>", "Path to archangel.yaml")
    .action(async (repo: string, issueArg: string, opts: { config?: string }) => {
      const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), repo);
      const paths = resolvePaths(cfg);
      const repoSlug = `${cfg.githubOwner}/${cfg.githubRepo}`;
      const ledger = new Ledger(paths.ledgerDbPath, { repo: repoSlug, timeZone: cfg.dailyTimezone });
      try {
        const preview = cachedWebPreview(ledger, repoSlug);
        if (!preview) throw new Error(`${repoSlug} has no web preview block in .agents/archangel.json (or the daemon has not read it yet)`);
        const broker = new GitBroker({ bareRepoPath: paths.brokerBareRepoPath, clonesDir: paths.clonesDir, defaultBranch: cfg.defaultBranch });
        const local = new LocalProvider(broker);
        const running = await startPocPreview(
          { ledger, broker, local, sandbox: new SandboxExecProvider(local, { reservedPorts: [cfg.ui.port] }), preview, dataDir: paths.dataDir, installTimeoutMs: cfg.setupTimeoutMs, github: new GitHubAppClient({ owner: cfg.githubOwner, repo: cfg.githubRepo, appId: cfg.githubAppId, installationId: cfg.githubInstallationId, privateKeyPem: cfg.githubPrivateKeyPem }) },
          Number(issueArg),
        );
        process.once("SIGINT", running.close);
        process.once("SIGTERM", running.close);
        console.log(`Preview of pitch #${issueArg}: ${running.url}  (sandboxed, loopback only; expires ${new Date(running.expiresAt).toLocaleTimeString()}; Ctrl-C to stop)`);
        await running.closed;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        ledger.close();
      }
    });
}
