import { createHash } from "node:crypto";
import path from "node:path";
import { App, EgressPolicy, Image, Sailbox, type ImageSpec } from "@sailresearch/sdk";
import type { GitBroker } from "../broker/git-broker.js";
import type { CliProvider, ComputeConfig } from "../config.js";
import { AGY_BROKER_SECRET, AGY_PLACEHOLDER_ENV } from "./agy-broker-adapter.js";
import { CODEX_BROKER_SECRET, CODEX_PLACEHOLDER_ENV } from "./codex-broker-adapter.js";
import { SailProvider, SailSpend, type SailBoxInfo, type SailClient } from "./sail.js";

/**
 * The real SailClient. Credentials come from the SDK itself (`sail auth login` under ~/.sail, or SAIL_API_KEY); this file never
 * reads, prints or logs them. A fresh box gets a saved egress allowlist and a pinned image.
 */

type SailConfig = NonNullable<ComputeConfig["sail"]>;
/** Bump when imageFor changes so a saved policy name changes with it. */
const IMAGE_REV = 2;

const CLAUDE_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";
const OPENAI_KEY = "OPENAI_API_KEY";
const GEMINI_KEY = "GEMINI_API_KEY";
/** The hosts agy 1.5.14 sends its consumer login to: the daily one was observed on the wire; the production one is inferred from the binary. */
const AGY_HOSTS = ["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"];

/**
 * Each provider that runs on Sail has one host, one placeholder env var and one header the egress policy swaps the real secret into.
 * Only hosts of configured providers are reachable, plus the package registry. GitHub is absent because the repo arrives as a bundle,
 * and so is every OAuth host (auth.openai.com, oauth2.googleapis.com): a box can never refresh a login.
 */
export function sailPolicyDoc(cfg: Pick<SailConfig, "claudeTokenSecret" | "codexApiKeySecret" | "codexBrokerHome" | "geminiApiKeySecret" | "agyBrokerHome"> & { image?: { egressHosts: string[] } }) {
  const routes = [
    { secret: cfg.claudeTokenSecret, host: "api.anthropic.com", env: CLAUDE_TOKEN, prefix: "sk-ant-oat01-", header: "authorization" },
    ...(cfg.codexApiKeySecret ? [{ secret: cfg.codexApiKeySecret, host: "api.openai.com", env: OPENAI_KEY, prefix: "sk-", header: "authorization" }] : []),
    // The broker's access token for a ChatGPT login: only chatgpt.com is reachable, never auth.openai.com, so a box cannot refresh.
    ...(cfg.codexBrokerHome ? [{ secret: CODEX_BROKER_SECRET, host: "chatgpt.com", env: CODEX_PLACEHOLDER_ENV, prefix: "cgpt-", header: "authorization" }] : []),
    // The broker's access token for a Google login: only the Cloud Code hosts are reachable, never oauth2.googleapis.com or accounts.google.com, so a box cannot refresh.
    ...(cfg.agyBrokerHome ? AGY_HOSTS.map((host) => ({ secret: AGY_BROKER_SECRET, host, env: AGY_PLACEHOLDER_ENV, prefix: "ya29", header: "authorization" })) : []),
    ...(cfg.geminiApiKeySecret ? [{ secret: cfg.geminiApiKeySecret, host: "generativelanguage.googleapis.com", env: GEMINI_KEY, prefix: "AIza", header: "x-goog-api-key" }] : []),
  ];
  return {
    allowlist: [...routes.map((r) => r.host), "registry.npmjs.org", ...(cfg.image?.egressHosts ?? [])],
    env: Object.fromEntries(routes.map((r) => [r.env, { secret: r.secret, placeholder_prefix: r.prefix }])),
    // A rule names the stored secret, not the env var.
    rules: Object.fromEntries(routes.map((r) => [r.host, [{ request: { replace: { headers: { [r.header]: r.secret } } } }]])),
  };
}

/** The providers whose entries run on Sail: claude when asked for, codex and agy when their API key secret is configured. Deterministic per entry, never a failover. */
export function remoteProviders(compute: ComputeConfig): ReadonlySet<CliProvider> {
  const sail = compute.provider === "sail" ? compute.sail : undefined;
  const set = new Set<CliProvider>();
  if (sail?.remoteClaudeAttempts) set.add("claude");
  if (sail?.codexApiKeySecret || sail?.codexBrokerHome) set.add("codex");
  if (sail?.geminiApiKeySecret || sail?.agyBrokerHome) set.add("agy");
  return set;
}

function imageFor({ arch, setup }: SailConfig["image"]): Image {
  const base = Image.debian(arch)
    .aptInstall("git", "curl", "ca-certificates", "unzip", "gnupg")
    .runCommand("curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs")
    .runCommand("curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash")
    .runCommand("npm install -g @anthropic-ai/claude-code @openai/codex")
    .runCommand("curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin");
  return setup.reduce((image, command) => image.runCommand(command), base);
}

export function createSailClient(cfg: SailConfig): SailClient {
  // Sail caches an image build and a saved policy by content: the spec hash names the policy, so a changed spec makes a new one.
  const specHash = createHash("sha256").update(JSON.stringify([cfg.image, sailPolicyDoc(cfg), IMAGE_REV])).digest("hex").slice(0, 10);
  let ready: Promise<{ app: App; image: ImageSpec; policy: EgressPolicy }> | null = null;
  const setup = () =>
    (ready ??= (async () => {
      const app = await App.find(cfg.app, { mintIfMissing: true });
      const image = await imageFor(cfg.image).build({ timeoutSeconds: 1800 });
      const name = `${cfg.app}-${specHash}`;
      const existing = (await EgressPolicy.list()).find((p) => p.name === name);
      const policy = existing ? await EgressPolicy.get(existing.id) : await EgressPolicy.create(name, sailPolicyDoc(cfg));
      return { app, image, policy };
    })());
  const info = (b: Sailbox): SailBoxInfo => ({ id: b.sailboxId, name: b.name });
  const live = (b: Sailbox) => String(b.status) !== "terminated";

  return {
    async findBox(name) {
      const hit = (await Sailbox.list({})).find((b) => b.name === name && live(b));
      return hit ? info(hit) : null;
    },
    async createBox({ name, maxLifetimeSeconds }) {
      const { app, image, policy } = await setup();
      return info(await Sailbox.create({ app, name, image, egressPolicy: policy, maxLifetimeSeconds }));
    },
    async run(boxId, spec) {
      const proc = await Sailbox.fromId(boxId).exec(spec.argv, {
        cwd: spec.cwd,
        env: spec.env as Record<string, string>,
        timeoutSeconds: Math.max(1, Math.ceil(spec.timeoutMs / 1000)),
        openStdin: spec.stdin !== undefined,
      });
      const onAbort = () => void proc.cancel({ force: true }).catch(() => undefined);
      if (spec.signal?.aborted) onAbort();
      spec.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (spec.stdin !== undefined) {
          await proc.writeStdin(spec.stdin);
          await proc.closeStdin();
        }
        const pump = async (stream: AsyncIterable<unknown>, cb?: (s: string) => void) => {
          let all = "";
          for await (const chunk of stream) {
            const s = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
            all += s;
            cb?.(s);
          }
          return all;
        };
        const [stdout, stderr] = await Promise.all([pump(proc.stdout, spec.onStdout), pump(proc.stderr, spec.onStderr)]);
        const r = await proc.wait();
        return { code: r.timedOut ? null : r.exitCode, stdout, stderr, timedOut: r.timedOut };
      } finally {
        spec.signal?.removeEventListener("abort", onAbort);
      }
    },
    async writeFile(boxId, remotePath, data) {
      await Sailbox.fromId(boxId).fs.write(remotePath, data, { createParents: true });
    },
    async readFile(boxId, remotePath) {
      return Sailbox.fromId(boxId).fs.read(remotePath);
    },
    async terminate(boxId) {
      try {
        await Sailbox.fromId(boxId).terminate();
      } catch (err) {
        // Terminating a box that is already gone is the idempotent case; anything else is real.
        if (!/not.?found|404|terminated/i.test(String((err as Error)?.message ?? err))) throw err;
      }
    },
    async list(prefix) {
      return (await Sailbox.list({})).filter((b) => b.name.startsWith(prefix) && live(b)).map(info);
    },
  };
}

/** One provider per watched repo (its Broker makes the bundles); box names carry the repo so each sweep touches only its own. */
export function createSailProvider(opts: { sail: SailConfig; broker: GitBroker; dataDir: string; repoSlug: string }): SailProvider {
  const slug = opts.repoSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return new SailProvider({
    client: createSailClient(opts.sail),
    broker: opts.broker,
    namePrefix: `${opts.sail.app}-${slug}-`,
    maxLifetimeSeconds: opts.sail.maxLifetimeSeconds,
    maxDailyComputeUsd: opts.sail.maxDailyComputeUsd,
    spend: new SailSpend(path.join(opts.dataDir, "sail-spend.json")),
  });
}

/** Where remote Attempts (implement, revise, rebase) run: Sail only when some provider has a remote credential configured. */
export function remoteAttemptProvider<P>(cfg: { compute: ComputeConfig }, sail: P | undefined): P | undefined {
  return remoteProviders(cfg.compute).size > 0 ? sail : undefined;
}
