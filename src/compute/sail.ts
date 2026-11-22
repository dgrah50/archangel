import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tryParseJson } from "../core/json.js";
import { MAX_RESULT_BUNDLE_BYTES, type GitBroker } from "../broker/git-broker.js";
import type { CollectedResult, ComputeProvider, ExecResult, ExecSpec, Exposed, ListedPreview, PrepareSpec, Workspace } from "./provider.js";

/**
 * A ComputeProvider on Sail Sailboxes. The repo goes in as a git bundle the Broker makes locally (the box never holds a Git
 * credential); the result comes back as a bundle that is verified locally and then validated by the Broker like any clone.
 * Nothing from this machine's environment enters a box: `exec` passes only the env it is given.
 *
 * Peak RSS is not measured on Sail: `exec` reports `peakRssKb: null`.
 */

/** Estimated Sail rates (docs pricing page; the launch post lists different ones): $/used vCPU-h, $/used GiB-h, $/GiB-h disk, $ per box created. */
export const SAIL_RATES = { vcpuHour: 0.015, memGibHour: 0.008, diskGibHour: 0.0007, perBox: 0.01 };
/** What a Scout box is assumed to use. These size the estimate, not the box. */
const ASSUMED_USE = { vcpu: 1, memGib: 4, diskGib: 10 };
export const SAIL_USD_PER_BOX_MINUTE = (ASSUMED_USE.vcpu * SAIL_RATES.vcpuHour + ASSUMED_USE.memGib * SAIL_RATES.memGibHour + ASSUMED_USE.diskGib * SAIL_RATES.diskGibHour) / 60;

export const MAX_START_BUNDLE_BYTES = 500 * 1024 * 1024;
const REPO_DIR = "/work/repo";
const START_MARK = "/work/.start-sha";
const RESULT_BUNDLE = "/work/out.bundle";

export interface SailBoxInfo {
  id: string;
  name: string;
}

/** The slice of the Sail SDK this provider uses. The real one is `sail-sdk.ts`; tests pass a fake. */
export interface SailClient {
  /** A live (not terminated) box with exactly this name, or null. */
  findBox(name: string): Promise<SailBoxInfo | null>;
  createBox(opts: { name: string; maxLifetimeSeconds: number }): Promise<SailBoxInfo>;
  run(
    boxId: string,
    spec: { argv: string[]; cwd?: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; signal?: AbortSignal; onStdout?: (s: string) => void; onStderr?: (s: string) => void },
  ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
  writeFile(boxId: string, remotePath: string, data: Buffer): Promise<void>;
  readFile(boxId: string, remotePath: string): Promise<Buffer>;
  /** Idempotent: terminating a box that is gone is not an error. */
  terminate(boxId: string): Promise<void>;
  /** Live boxes whose name starts with `prefix`. */
  list(prefix: string): Promise<SailBoxInfo[]>;
}

/** The day's estimated spend, persisted so a daemon restart does not forget it. Days are UTC. */
export class SailSpend {
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  private read(): { day: string; usd: number } {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (!fs.existsSync(this.file)) return { day: today, usd: 0 };
    const parsed = tryParseJson(fs.readFileSync(this.file, "utf8"));
    const v = (parsed.ok ? parsed.value : {}) as { day?: string; usd?: number };
    return v.day === today && typeof v.usd === "number" ? { day: today, usd: v.usd } : { day: today, usd: 0 };
  }

  total(): number {
    return this.read().usd;
  }

  add(usd: number): void {
    const cur = this.read();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ day: cur.day, usd: Math.max(0, cur.usd + usd) }));
  }
}

export interface SailProviderOptions {
  client: SailClient;
  broker: Pick<GitBroker, "createStartBundle" | "verifyBundle">;
  /** Box names start with this, and the orphan sweep only touches names that do. */
  namePrefix: string;
  maxLifetimeSeconds: number;
  maxDailyComputeUsd: number;
  spend: SailSpend;
}

const sh = (script: string): string[] => ["bash", "-c", `set -e; ${script}`];

export class SailProvider implements ComputeProvider {
  readonly remote = true;
  /** Boxes this process prepared and has not destroyed: the live Attempts that own a box. */
  private readonly live = new Set<string>();
  private readonly startedAt = new Map<string, number>();

  constructor(private readonly o: SailProviderOptions) {}

  private async sh(boxId: string, script: string, timeoutMs = 180_000): Promise<string> {
    const r = await this.o.client.run(boxId, { argv: sh(script), env: {}, timeoutMs });
    if (r.code !== 0) throw new Error(`sail box command failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}`);
    return r.stdout;
  }

  async prepare(spec: PrepareSpec): Promise<Workspace> {
    // One box per Attempt: the same issue and start commit find the same box.
    const name = `${this.o.namePrefix}${spec.issueNumber}-${spec.startSha.slice(0, 12)}`;
    let box = await this.o.client.findBox(name);
    if (!box) {
      const reserve = SAIL_RATES.perBox + (this.o.maxLifetimeSeconds / 60) * SAIL_USD_PER_BOX_MINUTE;
      if (this.o.spend.total() + reserve > this.o.maxDailyComputeUsd) {
        throw new Error(`Sail compute cap: estimated $${this.o.spend.total().toFixed(2)} spent today plus $${reserve.toFixed(2)} for a new box exceeds maxDailyComputeUsd $${this.o.maxDailyComputeUsd}`);
      }
      box = await this.o.client.createBox({ name, maxLifetimeSeconds: this.o.maxLifetimeSeconds });
      this.o.spend.add(reserve);
      this.startedAt.set(box.id, Date.now());
    }
    const ws: Workspace = { id: box.id, path: REPO_DIR };
    this.live.add(box.id);
    try {
      const marked = await this.o.client.run(box.id, { argv: ["cat", START_MARK], env: {}, timeoutMs: 30_000 });
      if (marked.code === 0 && marked.stdout.trim() === spec.startSha) return ws;
      const bundle = await this.o.broker.createStartBundle(spec.issueNumber, spec.startSha);
      try {
        const bytes = fs.readFileSync(bundle);
        if (bytes.length > MAX_START_BUNDLE_BYTES) throw new Error(`start bundle is ${bytes.length} bytes, over the ${MAX_START_BUNDLE_BYTES} byte cap`);
        await this.o.client.writeFile(box.id, "/work/start.bundle", bytes);
      } finally {
        fs.rmSync(bundle, { force: true });
      }
      await this.sh(
        box.id,
        [
          `mkdir -p ${REPO_DIR}`,
          `cd ${REPO_DIR}`,
          "git init -q",
          `git fetch -q /work/start.bundle refs/archangel/start/${spec.issueNumber}:refs/archangel/start`,
          `git checkout -q -f -B factory/${spec.issueNumber} ${spec.startSha}`,
          `git config user.name 'Archangel Worker'`,
          `git config user.email archangel-worker@users.noreply.github.com`,
          `echo ${spec.startSha} > ${START_MARK}`,
        ].join(" && "),
      );
      return ws;
    } catch (err) {
      this.destroy(ws);
      throw err;
    }
  }

  async exec(ws: Workspace, spec: ExecSpec): Promise<ExecResult> {
    const startedAt = Date.now();
    const r = await this.o.client.run(ws.id, {
      argv: [spec.cmd, ...spec.args],
      cwd: ws.path,
      env: spec.env,
      stdin: spec.stdin,
      timeoutMs: spec.timeoutMs,
      signal: spec.signal,
      onStdout: spec.onStdout,
      onStderr: spec.onStderr,
    });
    if (r.timedOut) spec.onTimeout?.();
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, aborted: spec.signal?.aborted ?? false, durationMs: Date.now() - startedAt, peakRssKb: null };
  }

  async collect(ws: Workspace): Promise<CollectedResult> {
    await this.sh(
      ws.id,
      [
        `cd ${REPO_DIR}`,
        "git add -A",
        "(git diff --cached --quiet || git commit --no-verify -q -m 'archangel factory attempt')",
        `git bundle create ${RESULT_BUNDLE} HEAD ^$(cat ${START_MARK})`,
      ].join(" && "),
    );
    const size = Number((await this.sh(ws.id, `stat -c %s ${RESULT_BUNDLE}`)).trim());
    if (!(size <= MAX_RESULT_BUNDLE_BYTES)) throw new Error(`result bundle is ${size} bytes, over the ${MAX_RESULT_BUNDLE_BYTES} byte cap`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-sail-"));
    const file = path.join(dir, "result.bundle");
    try {
      fs.writeFileSync(file, await this.o.client.readFile(ws.id, RESULT_BUNDLE));
      await this.o.broker.verifyBundle(file);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    return { kind: "bundle", path: file };
  }

  /** Idempotent. Fire and forget like the interface says: a failed terminate is left to `maxLifetimeSeconds` and the sweep. */
  destroy(ws: Workspace): void {
    this.live.delete(ws.id);
    const started = this.startedAt.get(ws.id);
    if (started !== undefined) {
      this.startedAt.delete(ws.id);
      const maxMin = this.o.maxLifetimeSeconds / 60;
      const usedMin = Math.min(maxMin, (Date.now() - started) / 60_000);
      this.o.spend.add(-(maxMin - usedMin) * SAIL_USD_PER_BOX_MINUTE);
    }
    void this.o.client.terminate(ws.id).catch(() => undefined);
  }

  async expose(): Promise<Exposed> {
    throw new Error("Sail can't expose a port yet: the SDK only offers a public HTTPS URL or public SSH, never a loopback forward");
  }

  async list(prefix: string): Promise<ListedPreview[]> {
    return (await this.o.client.list(prefix)).map((b) => ({ id: b.id, pgid: 0 }));
  }

  /** Terminates every prefixed box no live Attempt of this process owns; returns their ids. */
  async sweepOrphans(): Promise<string[]> {
    const swept: string[] = [];
    for (const b of await this.o.client.list(this.o.namePrefix)) {
      if (this.live.has(b.id)) continue;
      await this.o.client.terminate(b.id);
      swept.push(b.id);
    }
    return swept;
  }
}
