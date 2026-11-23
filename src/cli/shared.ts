import fs from "node:fs";
import { primaryWriterVendors, resolvePaths, type ArchangelConfig } from "../config.js";
import type { ReviewerSuite } from "../agents/reviewers.js";
import { SubscriptionReviewerSuite } from "../agents/subscription-reviewers.js";
import type { Ledger } from "../ledger/store.js";

export function makeReviewerSuite(cfg: ArchangelConfig, ledger: Ledger): ReviewerSuite {
  return new SubscriptionReviewerSuite({
    chain: cfg.reviewerChain,
    accounts: cfg.accounts,
    accountState: ledger.accountState(cfg.accounts),
    defaultExcludeVendors: primaryWriterVendors(cfg.chains),
  });
}

export function pickProjectConfig(configs: ArchangelConfig[], repoFlag?: string): ArchangelConfig {
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

/** Every repo in the Ledger with a Broker repo on disk, as eval sources. */
export function evalSources(ledger: Ledger, dataDir: string, only?: string) {
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
