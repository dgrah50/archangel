import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { promisify } from "node:util";
import { REPO_POLICY_PATH, loadProjectConfigs, providerToVendor, resolvePaths, resolveRequiredReviewers, type ArchangelConfig } from "../config.js";
import { assessPinDrift, latestGateCommit } from "./gate-pin.js";
import { execRunner } from "./onboard.js";
import { GitHubAppClient } from "../github/client.js";
import { Ledger } from "../ledger/store.js";

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  remediation?: string;
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
      remediation: "Copy .env.example -> .env and archangel.example.yaml -> archangel.yaml, then populate required fields.",
    });
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
    const neededProviders = [
      ...new Set([
        ...first.implementerChain.map((e) => e.provider),
        ...first.reviewerChain.map((e) => e.provider),
      ]),
    ];
    const missingBins: string[] = [];
    const verified: string[] = [];
    for (const p of neededProviders) {
      try {
        if (p === "codex") {
          const { stdout, stderr } = await execFileAsync("codex", ["login", "status"]);
          const combined = `${stdout}\n${stderr}`.trim();
          if (/not\s+logged\s+in/i.test(combined) || !/logged in/i.test(combined)) {
            missingBins.push("codex (not logged in — run `codex login`)");
          } else {
            verified.push(`codex (${combined})`);
          }
        } else {
          const { stdout } = await execFileAsync(p, ["--version"]);
          verified.push(`${p} (${stdout.trim().split("\n")[0]})`);
        }
      } catch {
        missingBins.push(`${p} (not found in PATH)`);
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
        detail: `${verified.join(", ")} (chain: impl=${first.implementerChain.map((e) => e.provider).join("->")}, rev=${first.reviewerChain.map((e) => e.provider).join("->")})`,
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
      for (const p of neededProviders) {
        checks.push(await smokeProvider(p));
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
  } catch {
    checks.push({ id: "git", name: "Git Version", status: "fail", detail: "git not found in PATH" });
  }

  // 6. Optional pre-commit CLI (only needed if target repo's .pre-commit-config.yaml uses remote hook repos)
  try {
    const { stdout } = await execFileAsync("pre-commit", ["--version"]);
    checks.push({ id: "pre_commit", name: "pre-commit CLI (optional)", status: "pass", detail: stdout.trim() });
  } catch {
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
  } catch {
    checks.push({
      id: "paseo",
      name: "Paseo CLI (Handoff)",
      status: "warn",
      detail: "paseo CLI not found (optional unless using `archangel handoff`)",
    });
  }

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
              remediation: drift.drifted ? `archangel gate bump --repo ${repoSlug}` : undefined,
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

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

// Version + login-status commands only; none of these spend model quota.
// agy has no login-status command, so for it only installation is verified.
async function smokeProvider(provider: string): Promise<DoctorCheck> {
  const id = `smoke_provider:${provider}`;
  const name = `Smoke Check (${provider})`;
  const login = provider === "codex" ? `${provider} login` : `${provider} auth login`;
  try {
    const { stdout: v } = await execFileAsync(provider, ["--version"]);
    const version = v.trim().split("\n")[0];
    if (provider === "agy") {
      return { id, name, status: "pass", detail: `${version} (installed; auth not verifiable without a model call)` };
    }
    const args = provider === "codex" ? ["login", "status"] : ["auth", "status"];
    const { stdout, stderr } = await execFileAsync(provider, args);
    const out = `${stdout}\n${stderr}`.trim();
    const ok = provider === "claude" ? /"loggedIn"\s*:\s*true/.test(out) : /logged in/i.test(out) && !/not\s+logged\s+in/i.test(out);
    if (!ok) {
      return { id, name, status: "fail", detail: `${provider} not logged in (${out || "no status output"})`, remediation: `Run \`${login}\`, then retry \`archangel doctor --smoke\`.` };
    }
    return { id, name, status: "pass", detail: `${version}; logged in` };
  } catch (err) {
    const missing = err instanceof Error && "code" in err && err.code === "ENOENT";
    return {
      id,
      name,
      status: "fail",
      detail: missing ? `${provider} not found in PATH` : `${provider} check failed: ${err instanceof Error ? err.message : String(err)}`,
      remediation: `Install the ${provider} CLI and run \`${login}\`, then retry \`archangel doctor --smoke\`.`,
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
  cfg: Pick<ArchangelConfig, "authMode" | "implementerChain" | "reviewerChain">,
): string[] {
  const vendors = [...new Set(cfg.implementerChain.map((e) => providerToVendor(e.provider)))];
  return vendors.filter((v) => resolveRequiredReviewers(cfg, [v]).length < 2);
}
