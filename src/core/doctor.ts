import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { promisify } from "node:util";
import { ConfigError, REPO_POLICY_PATH, accountEnv, accountsFor, loadProjectConfigs, resolvePaths, resolveRequiredReviewers, writerVendors, type Account, type ArchangelConfig } from "../config.js";
import { assessPinDrift, latestGateCommit } from "./gate-pin.js";
import { execRunner } from "./onboard.js";
import { loadWorkflow, workflowError } from "./workflow-load.js";
import type { EffectiveWorkflow } from "./workflow.js";
import { GitHubAppClient } from "../github/client.js";
import { Ledger } from "../ledger/store.js";

const execFileAsync = promisify(execFile);

/** Shown by the doctor and the dashboard Accounts panel when more than one agy account is configured. */
export const AGY_HOME_WARNING = "agy account separation via HOME is unverified: agy has no per-login setting, so each agy account's home is passed as HOME, and a token kept in the OS keychain would be shared between them";

export interface DoctorCheck {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  remediation?: string;
  /** `machine` checks need no network; `repo` checks call GitHub. */
  scope?: "machine" | "repo";
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  offline?: boolean;
  apiBaseUrl?: string;
  /** Per-provider version + login-status checks (never invokes a model). */
  smoke?: boolean;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const env = opts.env ?? process.env;

  // 1. Load config
  let projects: ArchangelConfig[] = [];
  try {
    projects = loadProjectConfigs({ configPath: opts.configPath, env });
    const first = projects[0]!;
    if (first.ownerUserId === 123456) {
      checks.push({
        id: "config",
        name: "Configuration",
        status: "warn",
        detail: "ownerUserId is still placeholder 123456",
        remediation: "Run `gh api user --jq .id` and update ownerUserId in archangel.yaml",
      });
    } else {
      checks.push({
        id: "config",
        name: "Configuration",
        status: "pass",
        detail: `Loaded ${projects.length} project(s): ${projects.map((p) => `${p.githubOwner}/${p.githubRepo}`).join(", ")}`,
      });
    }
  } catch (err) {
    checks.push({
      id: "config",
      name: "Configuration",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      remediation: err instanceof ConfigError ? err.remediation : "Check archangel.yaml and .env.",
    });
    for (const c of checks) c.scope = "machine";
    return { ok: false, checks };
  }

  const first = projects[0]!;
  const paths = resolvePaths(first);

  // 2. Private key PEM parsing
  try {
    crypto.createPrivateKey(first.githubPrivateKeyPem);
    checks.push({
      id: "private_key",
      name: "GitHub App Private Key PEM",
      status: "pass",
      detail: "Valid RSA/PKCS private key parsed cleanly",
    });
  } catch (err) {
    checks.push({
      id: "private_key",
      name: "GitHub App Private Key PEM",
      status: "fail",
      detail: `Invalid private key PEM: ${err instanceof Error ? err.message : String(err)}`,
      remediation: "Set ARCHANGEL_GITHUB_PRIVATE_KEY_PATH=/path/to/app.pem in .env",
    });
  }

  // 3. Model authentication (subscription CLIs vs metered API keys)
  if (first.authMode === "subscription") {
    // Every account any role chain can use: implement, revise, rebase, scout, triage, review.
    if (first.accounts.filter((a) => a.provider === "agy").length > 1) {
      checks.push({
        id: "agy_accounts",
        name: "agy Accounts",
        status: "warn",
        detail: AGY_HOME_WARNING,
        remediation: "Log each agy account in with its own HOME and confirm they are different Google accounts before relying on two of them.",
      });
    }
    const rolesByAccount = new Map<string, { account: Account; roles: string[] }>();
    for (const [role, chain] of [...Object.entries(first.chains), ["review", first.reviewerChain] as const]) {
      for (const e of chain) {
        for (const account of accountsFor(first.accounts, e)) {
          const cur = rolesByAccount.get(account.id) ?? { account, roles: [] };
          rolesByAccount.set(account.id, { account, roles: [...new Set([...cur.roles, role])] });
        }
      }
    }
    const neededAccounts = [...rolesByAccount.values()];
    const missingBins: string[] = [];
    const notInstalled = new Set<string>();
    const baseEnv = opts.env ?? process.env;
    const verified: string[] = [];
    for (const { account } of neededAccounts) {
      const p = account.provider;
      const label = account.id === p ? p : `${account.id} [${p}]`;
      const env = { ...baseEnv, ...accountEnv(account) };
      try {
        if (p === "codex") {
          const { stdout, stderr } = await execFileAsync("codex", ["login", "status"], { env });
          const combined = `${stdout}\n${stderr}`.trim();
          if (/not\s+logged\s+in/i.test(combined) || !/logged in/i.test(combined)) {
            missingBins.push(`${label} (not logged in — run \`codex login\`${account.home ? ` with CODEX_HOME=${account.home}` : ""})`);
          } else {
            verified.push(`${label} (${combined})`);
          }
        } else {
          const { stdout } = await execFileAsync(p, ["--version"], { env });
          verified.push(`${label} (${stdout.trim().split("\n")[0]})`);
        }
      } catch (_err) {
        if (!notInstalled.has(p)) missingBins.push(`${p} (not found in PATH; install the ${p} CLI, then log in)`);
        notInstalled.add(p);
      }
    }
    if (missingBins.length > 0) {
      checks.push({
        id: "subscription_clis",
        name: "Subscription CLI Providers",
        status: "fail",
        detail: `Unavailable: ${missingBins.join(", ")}`,
        remediation: "Install/log in to each configured CLI provider in archangel.yaml or switch authMode: api",
      });
    } else {
      checks.push({
        id: "subscription_clis",
        name: "Subscription CLI Providers",
        status: "pass",
        detail: `${verified.join(", ")} (${[...Object.entries(first.chains), ["review", first.reviewerChain] as const].map(([r, c]) => `${r}=${c.map((e) => e.provider).join("->")}`).join(", ")})`,
      });
    }
    const gaps = findReviewerIndependenceGaps(first);
    if (gaps.length > 0) {
      checks.push({
        id: "reviewer_independence",
        name: "Independent Reviewers",
        status: "warn",
        detail: `Fewer than 2 reviewers independent of implementer vendor(s): ${gaps.join(", ")}`,
        remediation: "Add reviewerChain providers from other vendors, or the thread escalates review_outage after implementing",
      });
    }
    if (opts.smoke) {
      for (const { account, roles } of neededAccounts) {
        if (notInstalled.has(account.provider)) continue;
        checks.push(await smokeAccount(account, roles, baseEnv));
      }
    }
  } else {
    const missingKeys = [
      !first.anthropicApiKey ? "ANTHROPIC_API_KEY" : null,
      !first.openaiApiKey ? "OPENAI_API_KEY" : null,
      !first.googleApiKey ? "GOOGLE_GENERATIVE_AI_API_KEY" : null,
    ].filter(Boolean) as string[];
    if (missingKeys.length > 0) {
      checks.push({
        id: "api_keys",
        name: "Metered Model API Keys",
        status: "fail",
        detail: `Missing: ${missingKeys.join(", ")}`,
        remediation: "Populate all three metered API keys in .env, or set authMode: subscription in archangel.yaml",
      });
    } else {
      checks.push({
        id: "api_keys",
        name: "Metered Model API Keys",
        status: "pass",
        detail: "Anthropic, OpenAI, and Google API keys present",
      });
    }
  }

  if (Boolean(first.telegramBotToken) !== Boolean(first.telegramChatId)) {
    checks.push({
      id: "telegram",
      name: "Telegram Notifier",
      status: "warn",
      detail: "Only one of ARCHANGEL_TELEGRAM_BOT_TOKEN / ARCHANGEL_TELEGRAM_CHAT_ID is set",
      remediation: "Set both env vars or unset both to stay GitHub-only",
    });
  }

  // 4. SQLite separation (ADR-0001)
  if (paths.ledgerDbPath === paths.mastraDbPath) {
    checks.push({
      id: "sqlite_paths",
      name: "SQLite DB Isolation",
      status: "fail",
      detail: `ledgerDbPath and mastraDbPath collide at ${paths.ledgerDbPath}`,
      remediation: "Keep ledger.db and mastra.db in separate files to prevent SQLITE_BUSY",
    });
  } else {
    try {
      fs.mkdirSync(paths.dataDir, { recursive: true });
      fs.accessSync(paths.dataDir, fs.constants.W_OK);
      checks.push({
        id: "sqlite_paths",
        name: "SQLite DB Isolation",
        status: "pass",
        detail: `Separate DBs in writable ${paths.dataDir}`,
      });
    } catch (err) {
      checks.push({
        id: "sqlite_paths",
        name: "SQLite DB Isolation",
        status: "fail",
        detail: `dataDir not writable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // 4b. Autonomy cap: steps taken since the owner was last heard from (read-only; no ledger is created).
  for (const cfg of projects) {
    const slug = `${cfg.githubOwner}/${cfg.githubRepo}`;
    const dbPath = resolvePaths(cfg).ledgerDbPath;
    let steps = 0;
    if (fs.existsSync(dbPath)) {
      const ledger = new Ledger(dbPath, { repo: slug, readonly: true });
      try {
        steps = ledger.autonomousStepsSinceOwner();
      } finally {
        ledger.close();
      }
    }
    const cap = cfg.maxAutonomousStepsWithoutOwner;
    checks.push({
      id: `autonomy_cap:${slug}`,
      name: `Autonomy Cap (${slug})`,
      status: steps >= cap ? "warn" : "pass",
      detail: `${steps}/${cap} autonomous steps since the owner was last heard from`,
      remediation: steps >= cap ? "Reply on any Thread or run `archangel retry` to continue." : undefined,
    });
  }

  // 5. git >= 2.38 (for git merge-tree --write-tree)
  try {
    const { stdout } = await execFileAsync("git", ["--version"]);
    const m = stdout.match(/(\d+)\.(\d+)/);
    const major = m ? Number(m[1]) : 0;
    const minor = m ? Number(m[2]) : 0;
    if (major > 2 || (major === 2 && minor >= 38)) {
      checks.push({ id: "git", name: "Git Version", status: "pass", detail: stdout.trim() });
    } else {
      checks.push({
        id: "git",
        name: "Git Version",
        status: "fail",
        detail: `${stdout.trim()} is below 2.38 (needed for git merge-tree --write-tree)`,
      });
    }
  } catch (_err) {
    checks.push({ id: "git", name: "Git Version", status: "fail", detail: "git not found in PATH" });
  }

  // 6. Optional pre-commit CLI (only needed if target repo's .pre-commit-config.yaml uses remote hook repos)
  try {
    const { stdout } = await execFileAsync("pre-commit", ["--version"]);
    checks.push({ id: "pre_commit", name: "pre-commit CLI (optional)", status: "pass", detail: stdout.trim() });
  } catch (_err) {
    checks.push({
      id: "pre_commit",
      name: "pre-commit CLI (optional)",
      status: "pass",
      detail: "Not installed (repo: local hooks run natively without Python pre-commit)",
    });
  }

  // 7. Paseo CLI (optional warn)
  try {
    const { stdout } = await execFileAsync("paseo", ["--version"]);
    checks.push({ id: "paseo", name: "Paseo CLI (Handoff)", status: "pass", detail: stdout.trim() });
  } catch (_err) {
    checks.push({
      id: "paseo",
      name: "Paseo CLI (Handoff)",
      status: "warn",
      detail: "paseo CLI not found (optional unless using `archangel handoff`)",
    });
  }

  // 8. The owner's `gh` login: onboarding and the dashboard's PR proposals use it (never the App identity).
  try {
    await execFileAsync("gh", ["auth", "status"]);
    checks.push({ id: "gh_auth", name: "Owner gh login", status: "pass", detail: "gh is authenticated" });
  } catch (_err) {
    checks.push({
      id: "gh_auth",
      name: "Owner gh login",
      status: "warn",
      detail: "gh is not installed or not logged in (needed for onboarding and dashboard PR proposals)",
      remediation: "Run `gh auth login`",
    });
  }

  for (const c of checks) c.scope = "machine";
  if (opts.offline) {
    return { ok: checks.every((c) => c.status !== "fail"), checks };
  }

  // 9. Online GitHub App least-privilege permission audit + target repo checks (ADR-0004!)
  let gateLatest: string | undefined;
  for (const cfg of projects) {
    const repoSlug = `${cfg.githubOwner}/${cfg.githubRepo}`;
    const gh = new GitHubAppClient({
      owner: cfg.githubOwner,
      repo: cfg.githubRepo,
      appId: cfg.githubAppId,
      installationId: cfg.githubInstallationId,
      privateKeyPem: cfg.githubPrivateKeyPem,
      apiBaseUrl: opts.apiBaseUrl,
    });

    try {
      const meta = await gh.mintInstallationTokenWithMeta();
      const perms = meta.permissions;
      const missingReq: string[] = [];
      if (perms.contents !== "write") missingReq.push("contents:write");
      if (perms.pull_requests !== "write") missingReq.push("pull_requests:write");
      if (perms.issues !== "write") missingReq.push("issues:write");
      if (perms.checks !== "read") missingReq.push("checks:read");

      const forbidden: string[] = [];
      if (perms.workflows) forbidden.push(`workflows:${perms.workflows}`);
      if (perms.administration) forbidden.push(`administration:${perms.administration}`);
      if (perms.checks === "write") forbidden.push("checks:write");

      if (missingReq.length > 0 || forbidden.length > 0) {
        const parts: string[] = [];
        if (missingReq.length > 0) parts.push(`missing [${missingReq.join(", ")}]`);
        if (forbidden.length > 0) parts.push(`FORBIDDEN [${forbidden.join(", ")}]`);
        checks.push({
          id: `github_app_permissions:${repoSlug}`,
          name: `GitHub App Permissions (${repoSlug})`,
          status: "fail",
          detail: parts.join("; "),
          remediation:
            "Grant strictly contents:write, pull_requests:write, issues:write, checks:read — and NO workflows, administration, or checks:write (ADR-0004).",
        });
      } else {
        checks.push({
          id: `github_app_permissions:${repoSlug}`,
          name: `GitHub App Permissions (${repoSlug})`,
          status: "pass",
          detail: "Verified exact least-privilege App permissions (no workflows/administration/checks:write)",
        });
      }

      const tip = await gh.getBranchTipSha(cfg.defaultBranch);
      const hasGateWf = await gh.fileExistsAtRef(tip, ".github/workflows/archangel-gate.yml");
      checks.push({
        id: `gate_workflow:${repoSlug}`,
        name: `Gate Workflow on ${cfg.defaultBranch} (${repoSlug})`,
        status: hasGateWf ? "pass" : "fail",
        detail: hasGateWf
          ? `.github/workflows/archangel-gate.yml present at ${tip.slice(0, 8)}`
          : `.github/workflows/archangel-gate.yml missing on ${cfg.defaultBranch}`,
        remediation: hasGateWf
          ? undefined
          : "Copy workflows/archangel-gate.yml into .github/workflows/archangel-gate.yml (pin ARCHANGEL_GATE_SHA) and merge to default branch",
      });

      if (hasGateWf) {
        const wf = await gh.readFileAtRef(tip, ".github/workflows/archangel-gate.yml");
        if (wf !== null) {
          try {
            gateLatest ??= await latestGateCommit(execRunner);
            const drift = await assessPinDrift(execRunner, wf, gateLatest);
            checks.push({
              id: `gate_pin:${repoSlug}`,
              name: `Gate Pin (${repoSlug})`,
              status: drift.drifted ? "warn" : "pass",
              detail: drift.drifted ? drift.reasons.join("; ") : `pin is current (latest gate-relevant commit ${gateLatest.slice(0, 10)})`,
              remediation: drift.drifted ? `archangel gate-bump --repo ${repoSlug}` : undefined,
            });
          } catch (err) {
            checks.push({
              id: `gate_pin:${repoSlug}`,
              name: `Gate Pin (${repoSlug})`,
              status: "warn",
              detail: `could not assess pin drift: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }

      checks.push(describeLanding(repoSlug, await loadWorkflow(gh, cfg, { isScoutAutoPromoteRevoked: () => false }, tip)));

      const hasPreCommit =
        (await gh.fileExistsAtRef(tip, ".pre-commit-config.yaml")) ||
        (await gh.fileExistsAtRef(tip, ".pre-commit-config.yml"));
      const hasRepoPolicy = await gh.fileExistsAtRef(tip, REPO_POLICY_PATH);
      checks.push({
        id: `repo_verification:${repoSlug}`,
        name: `Repo Verification Config (${repoSlug})`,
        status: !hasRepoPolicy ? "fail" : hasPreCommit ? "pass" : "warn",
        detail: `.pre-commit-config.yaml=${hasPreCommit ? "present" : "missing"}, ${REPO_POLICY_PATH}=${hasRepoPolicy ? "present" : "missing"}`,
        remediation:
          hasPreCommit && hasRepoPolicy
            ? undefined
            : "Commit .pre-commit-config.yaml and .agents/archangel.json to the default branch (see templates/go/ or this repo's .agents/archangel.json)",
      });

      const repoLabels = new Set(await gh.listRepoLabels());
      const requiredLabels = Object.values(cfg.labels);
      const missingLabels = requiredLabels.filter((l) => !repoLabels.has(l));
      checks.push({
        id: `repo_labels:${repoSlug}`,
        name: `Required Labels (${repoSlug})`,
        status: missingLabels.length === 0 ? "pass" : "warn",
        detail:
          missingLabels.length === 0
            ? "All factory labels present"
            : `Missing labels: ${missingLabels.join(", ")}`,
        remediation:
          missingLabels.length === 0
            ? undefined
            : `Create missing labels in ${repoSlug}: ${missingLabels.join(", ")}`,
      });
    } catch (err) {
      checks.push({
        id: `github_online:${repoSlug}`,
        name: `GitHub API (${repoSlug})`,
        status: "fail",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 10. Optional Paseo daemon TCP probe
  if (first.paseoHost && !first.paseoHost.startsWith("ws")) {
    const [host, portStr] = first.paseoHost.split(":");
    const port = Number(portStr ?? 6767);
    const reachable = await tcpProbe(host || "127.0.0.1", port, 500);
    checks.push({
      id: "paseo_daemon",
      name: "Paseo Daemon Reachability",
      status: reachable ? "pass" : "warn",
      detail: reachable
        ? `Listening on ${first.paseoHost}`
        : `Not reachable at ${first.paseoHost} (only needed for Handoff)`,
    });
  }

  for (const c of checks) c.scope ??= "repo";
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

// Version + login-status commands only; none of these spend model quota.
// agy has no login-status command, so for it only installation is verified.
async function smokeAccount(account: Account, roles: string[], baseEnv: NodeJS.ProcessEnv = process.env): Promise<DoctorCheck> {
  const provider = account.provider;
  const id = `smoke_provider:${account.id}`;
  const label = account.id === provider ? provider : `${account.id} [${provider}]`;
  const name = `Smoke Check (${label}${roles.length > 0 ? `, used by: ${roles.join(", ")}` : ""})`;
  const env = { ...baseEnv, ...accountEnv(account) };
  const login = provider === "codex" ? `${provider} login` : `${provider} auth login`;
  const homeHint = account.home ? ` with ${provider === "claude" ? "CLAUDE_CONFIG_DIR" : provider === "codex" ? "CODEX_HOME" : "HOME"}=${account.home}` : "";
  try {
    const { stdout: v } = await execFileAsync(provider, ["--version"], { env });
    const version = v.trim().split("\n")[0];
    if (provider === "agy") {
      return { id, name, status: "pass", detail: `${version} (installed; auth not verifiable without a model call)` };
    }
    const args = provider === "codex" ? ["login", "status"] : ["auth", "status"];
    const { stdout, stderr } = await execFileAsync(provider, args, { env });
    const out = `${stdout}\n${stderr}`.trim();
    const ok = provider === "claude" ? /"loggedIn"\s*:\s*true/.test(out) : /logged in/i.test(out) && !/not\s+logged\s+in/i.test(out);
    if (!ok) {
      return { id, name, status: "fail", detail: `${label} not logged in (${out || "no status output"})`, remediation: `Run \`${login}\`${homeHint}, then retry \`archangel doctor --smoke\`.` };
    }
    return { id, name, status: "pass", detail: `${version}; logged in` };
  } catch (err) {
    const missing = err instanceof Error && "code" in err && err.code === "ENOENT";
    return {
      id,
      name,
      status: "fail",
      detail: missing ? `${provider} not found in PATH` : `${label} check failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation: `Install the ${provider} CLI and run \`${login}\`${homeHint}, then retry \`archangel doctor --smoke\`.`,
    };
  }
}

function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Implementer vendors for which the reviewerChain cannot supply 2 independent reviewers. */
export function findReviewerIndependenceGaps(
  cfg: Pick<ArchangelConfig, "authMode" | "chains" | "reviewerChain">,
): string[] {
  const vendors = writerVendors(cfg.chains);
  return vendors.filter((v) => resolveRequiredReviewers(cfg, [v]).length < 2);
}

/** One line per repo: the effective bugfix landing mode and who decided it, so a silent switch is visible. */
export function describeLanding(repoSlug: string, wf: EffectiveWorkflow): DoctorCheck {
  const base = { id: `landing:${repoSlug}`, name: `Bugfix Landing (${repoSlug})` };
  if (wf.status !== "ok") {
    return {
      ...base,
      status: "warn",
      detail: `workflow ${wf.status}: ${workflowError(wf)}; the repo is halted until .agents/archangel.json is valid`,
    };
  }
  const l = wf.landingBugfix;
  const detail = l.declared
    ? `${l.value} (source: ${l.source}; repo declares ${l.declared})`
    : `${l.value} (source: ${l.source}${l.source === "repo" ? ", from landing.bugfix" : ""}); features always land by owner merge`;
  return { ...base, status: "pass", detail };
}
