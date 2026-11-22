#!/usr/bin/env node
/**
 * Lightweight standalone CLI entrypoint for `archangel gate`.
 * Bundled into `bin/archangel-gate.mjs` via esbuild so GitHub Actions runs Gate in <1s with ZERO `npm ci`.
 */
import { runGate, runGateForActions } from "./gate.js";

function parseArgs(argv: string[]): {
  repo: string;
  base: string;
  head: string;
  policyFromBase: boolean;
  revertOf?: string;
  baseRuns?: number;
  headRuns?: number;
  skipPreCommit: boolean;
  skipTests: boolean;
} {
  let repo = ".";
  let base = "";
  let head = "HEAD";
  let policyFromBase = false;
  let revertOf: string | undefined;
  let baseRuns: number | undefined;
  let headRuns: number | undefined;
  let skipPreCommit = false;
  let skipTests = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--repo" && argv[i + 1]) repo = argv[++i]!;
    else if (a === "--base" && argv[i + 1]) base = argv[++i]!;
    else if (a === "--head" && argv[i + 1]) head = argv[++i]!;
    else if (a === "--policy-from-base") policyFromBase = true;
    else if (a === "--revert-of" && argv[i + 1]) revertOf = argv[++i]!;
    else if (a === "--base-runs" && argv[i + 1]) baseRuns = Number(argv[++i]!);
    else if (a === "--head-runs" && argv[i + 1]) headRuns = Number(argv[++i]!);
    else if (a === "--skip-pre-commit") skipPreCommit = true;
    else if (a === "--skip-tests") skipTests = true;
  }

  if (!base) {
    throw new Error("Usage: archangel-gate --repo <dir> --base <ref> [--head <ref>] [--policy-from-base] [--revert-of <sha>]");
  }
  return { repo, base, head, policyFromBase, revertOf, baseRuns, headRuns, skipPreCommit, skipTests };
}

(async () => {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const runOpts = {
      repoDir: opts.repo,
      baseRef: opts.base,
      headRef: opts.head,
      policyFromBase: opts.policyFromBase,
      revertOf: opts.revertOf,
      baseRunsOverride: opts.baseRuns,
      headRunsOverride: opts.headRuns,
      skipPreCommit: opts.skipPreCommit,
      skipTests: opts.skipTests,
    };
    let report;
    if (process.env.GITHUB_ACTIONS === "true") {
      report = await runGateForActions(runOpts, console.log);
    } else {
      report = await runGate(runOpts);
      console.log(JSON.stringify(report, null, 2));
    }
    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
})();
