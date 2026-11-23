import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { loadProjectConfigs, primaryWriterVendors, resolvePaths, WRITER_ROLES, type WriterRole } from "../config.js";
import type { ReviewPromptBuilders } from "../agents/reviewers.js";
import { SubscriptionImplementer } from "../agents/subscription-implementer.js";
import { SubscriptionReviewerSuite } from "../agents/subscription-reviewers.js";
import { GitBroker } from "../broker/git-broker.js";
import { devFailures, renderCounts, renderEval, runEval, collectEvalCases, milestoneProgress, EVAL_THRESHOLDS } from "../core/eval.js";
import { loadReviewPrompts, prepareCandidates } from "../core/eval-candidate.js";
import { BENCH, parseChain, renderBench, runBenchTiers } from "../core/bench-tiers.js";
import { ARCHANGEL_ROOT } from "../core/onboard.js";
import { saveReport } from "../core/eval-reports.js";
import { proposePrompt } from "../core/prompt-proposer.js";
import { buildClusterBlockFrom } from "../core/failure-clusters.js";
import { defaultScoutCliInvoker } from "../core/scout.js";
import { ARCHANGEL_REPO, openDraftPr } from "../core/correction-draft.js";
import { GitHubAppClient } from "../github/client.js";
import { Ledger } from "../ledger/store.js";
import { resolveDataDir, resolveHostSettings } from "./data-dir.js";
import { evalSources, pickProjectConfig } from "./shared.js";

export function registerEval(program: Command): void {
  const evalCmd = program.command("eval").description("Offline review eval: score a candidate prompt/rubric change against captured, labelled cases (never lands anything)");

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
          suiteFor: (prompts) => new SubscriptionReviewerSuite({ chain: host.reviewerChain, defaultExcludeVendors: primaryWriterVendors(host.chains), timeoutMs: host.reviewTimeoutMs, prompts }),
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
    .command("propose")
    .description("Draft one prompt or rubric change from dev-set failure counts, score it on the held-out set and, only if it beats the baseline, open an agent-draft PR as the App (never merged by the daemon). At most one per week; safe to run from a weekly schedule")
    .option("-c, --config <path>", "Path to archangel.yaml")
    .action(async (opts: { config?: string }) => {
      const host = resolveHostSettings(opts);
      const cfg = pickProjectConfig(loadProjectConfigs({ configPath: opts.config }), ARCHANGEL_REPO);
      const dataDir = host.dataDir;
      const root = resolvePaths({ dataDir });
      if (!fs.existsSync(root.ledgerDbPath)) return void console.log(`No Ledger found yet at ${root.ledgerDbPath}. Run \`archangel start\` first.`);
      const paths = resolvePaths(cfg);
      const ledger = new Ledger(root.ledgerDbPath, { repo: ARCHANGEL_REPO, timeZone: cfg.dailyTimezone });
      const now = Date.now();
      const suiteFor = (prompts: ReviewPromptBuilders) => new SubscriptionReviewerSuite({ chain: host.reviewerChain, defaultExcludeVendors: primaryWriterVendors(host.chains), timeoutMs: host.reviewTimeoutMs, prompts });
      try {
        const outcome = await proposePrompt({
          ledger,
          chain: host.chains.scout,
          invoker: defaultScoutCliInvoker,
          cwd: ARCHANGEL_ROOT,
          clusterBlock: buildClusterBlockFrom(ledger, { repo: null, now, excludeScouts: [] }),
          failures: async () => {
            return devFailures({ ledger, sources: evalSources(ledger, dataDir), suiteFor, baseline: await loadReviewPrompts(ARCHANGEL_ROOT) });
          },
          evaluate: async (patchFile) => {
            const { baseline, candidate } = await prepareCandidates(ARCHANGEL_ROOT, patchFile);
            try {
              const report = await runEval({ ledger, sources: evalSources(ledger, dataDir), suiteFor, baseline: baseline.prompts, candidate, heldout: true });
              saveReport(dataDir, "eval", report);
              return report;
            } finally {
              candidate.cleanup();
            }
          },
          openPr: (draft, body, ctx) =>
            openDraftPr(
              {
                github: new GitHubAppClient({ owner: cfg.githubOwner, repo: cfg.githubRepo, appId: cfg.githubAppId, installationId: cfg.githubInstallationId, privateKeyPem: cfg.githubPrivateKeyPem }),
                broker: new GitBroker({ bareRepoPath: paths.brokerBareRepoPath, clonesDir: paths.clonesDir, defaultBranch: cfg.defaultBranch, repo: ARCHANGEL_REPO }),
                defaultBranch: cfg.defaultBranch,
              },
              draft,
              body,
              ctx,
            ),
        }, now);
        const detail = outcome.kind === "skipped" ? outcome.why : outcome.kind === "pr_opened" ? outcome.url : outcome.kind === "not_better" ? outcome.report.reasons.join("; ") || outcome.report.result : outcome.reason;
        ledger.appendAudit(`prompt_proposer/${outcome.kind}`, null, "archangel", { detail: detail.slice(0, 500) }, now);
        console.log(outcome.kind === "pr_opened" ? `Opened ${outcome.url}` : `No PR (${outcome.kind}): ${detail}`);
      } finally {
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
}
