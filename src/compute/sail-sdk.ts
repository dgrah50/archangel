import { createHash } from "node:crypto";
import path from "node:path";
import { App, EgressPolicy, Image, Sailbox, type ImageSpec } from "@sailresearch/sdk";
import type { GitBroker } from "../broker/git-broker.js";
import type { ComputeConfig } from "../config.js";
import { SailProvider, SailSpend, type SailBoxInfo, type SailClient } from "./sail.js";

/**
 * The real SailClient. Credentials come from the SDK itself (`sail auth login` under ~/.sail, or SAIL_API_KEY); this file never
 * reads, prints or logs them. A fresh box gets a saved egress allowlist and a pinned image.
 */

type SailConfig = NonNullable<ComputeConfig["sail"]>;

/** Hosts a Scout box may reach: the model API and the package registry. GitHub is absent because the repo arrives as a bundle. */
export const SAIL_ALLOWLIST = ["api.anthropic.com", "registry.npmjs.org"];
const CLAUDE_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";

function imageFor(arch: "amd64" | "arm64"): Image {
  return Image.debian(arch)
    .aptInstall("git", "curl", "ca-certificates", "unzip", "gnupg")
    .runCommand("curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs")
    .runCommand("curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash")
    .runCommand("npm install -g @anthropic-ai/claude-code @openai/codex");
}

function policyDoc(cfg: SailConfig) {
  return {
    allowlist: SAIL_ALLOWLIST,
    env: { [CLAUDE_TOKEN]: { secret: cfg.claudeTokenSecret, placeholder_prefix: "sk-ant-oat01-" } },
    // The rule names the stored secret, not the env var.
    rules: { "api.anthropic.com": [{ request: { replace: { headers: { authorization: cfg.claudeTokenSecret } } } }] },
  };
}

export function createSailClient(cfg: SailConfig): SailClient {
  // Sail caches an image build and a saved policy by content: the spec hash names the policy, so a changed spec makes a new one.
  const specHash = createHash("sha256").update(JSON.stringify([cfg.image, SAIL_ALLOWLIST, cfg.claudeTokenSecret])).digest("hex").slice(0, 10);
  let ready: Promise<{ app: App; image: ImageSpec; policy: EgressPolicy }> | null = null;
  const setup = () =>
    (ready ??= (async () => {
      const app = await App.find(cfg.app, { mintIfMissing: true });
      const image = await imageFor(cfg.image.arch).build({ timeoutSeconds: 1800 });
      const name = `${cfg.app}-${specHash}`;
      const existing = (await EgressPolicy.list()).find((p) => p.name === name);
      const policy = existing ? await EgressPolicy.get(existing.id) : await EgressPolicy.create(name, policyDoc(cfg));
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

/** Where claude Attempts (implement, revise, rebase) run remotely: Sail only when asked for with `remoteClaudeAttempts`, and only with the subscription CLI (the API-mode SDK runs on this machine). */
export function remoteAttemptProvider<P>(cfg: { authMode: string; compute: ComputeConfig }, sail: P | undefined): P | undefined {
  return cfg.authMode === "subscription" && cfg.compute.provider === "sail" && cfg.compute.sail?.remoteClaudeAttempts ? sail : undefined;
}
