import fs from "node:fs";
import type { Command } from "commander";
import { resolvePaths } from "../config.js";
import { correctionCategories } from "../core/corrections.js";
import { describeEscalation, formatDecisionClass } from "../core/escalations.js";
import { saveReport } from "../core/eval-reports.js";
import { renderReplay, runReplay, type ReplayReport } from "../core/replay.js";
import { computeHealth, renderHealth, renderStages } from "../core/status-text.js";
import { groupThreads } from "../core/ui-state.js";
import { Ledger } from "../ledger/store.js";
import { resolveDataDir } from "./data-dir.js";

export function registerReports(program: Command): void {
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
          needsYou: threads.flatMap((t) => {
            if (t.phase.kind !== "needs_you") return [];
            const p = describeEscalation(t.phase.code, undefined, t.phase.cause);
            return [{ ...t, decisionClass: p.decisionClass, recommendation: p.recommendation }];
          }),
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
        const s = m.shipping;
        const pct = (r: number | null) => (r === null ? "n/a" : `${Math.round(r * 100)}%`);
        const span = (sec: number) => (sec < 7200 ? `${Math.round(sec / 60)}m` : `${Math.round(sec / 360) / 10}h`);
        if (s.settled === 0) {
          console.log("Shipping:    nothing has settled yet");
        } else {
          console.log(
            `Shipping:    ${s.settled} settled: ${s.shipped} shipped (${pct(s.shipRate)}; ${s.shippedByFactory} by the factory, ${s.shipped - s.shippedByFactory} merged by you), ${s.closedUnshipped} closed unshipped, ${s.waitingOnOwner} waiting on you`,
          );
          if (s.attemptsToShip && s.timeToShipSec) {
            console.log(`  First pass:  ${s.firstPass} of ${s.shipped} shipped with one Attempt and no escalation (${pct(s.firstPassRate)})`);
            console.log(
              `  To ship:     Attempts p50 ${s.attemptsToShip.p50}, p95 ${s.attemptsToShip.p95}, max ${s.attemptsToShip.max} | ${s.escalationsPerShipped} escalations, ${s.ownerRetriesPerShipped} owner retries per shipped Thread`,
            );
            console.log(`  Time:        p50 ${span(s.timeToShipSec.p50)}, p95 ${span(s.timeToShipSec.p95)} from intake to merge`);
          }
        }
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
            console.log(`  - (${e.count}x) ${e.error.replace(/\s+/g, " ").slice(0, 120)}`);
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
}
