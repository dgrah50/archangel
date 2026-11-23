import fs from "node:fs";
import type { Command } from "commander";
import { loadProjectConfigs, resolvePaths } from "../config.js";
import { GitBroker } from "../broker/git-broker.js";
import { sha256 } from "../core/reconciler.js";
import { extractPrFromPhase, stepPhase } from "../core/thread-machine.js";
import { collectOwnerReply } from "../core/owner-reply.js";
import { GitHubAppClient } from "../github/client.js";
import { handoffThreadToPaseo, PaseoCliRunner, resumeThreadFromPaseo } from "../handoff/paseo.js";
import { Ledger } from "../ledger/store.js";
import { resolveDataDir } from "./data-dir.js";
import { pickProjectConfig } from "./shared.js";
import { requireTransition } from "./transition.js";

export function registerThreads(program: Command): void {
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
}
