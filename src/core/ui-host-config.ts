import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { HostYamlSchema, loadProjectConfigs } from "../config.js";
import { redactSecrets } from "./ui-doctor.js";
import { ProposeRefusal } from "./ui-propose.js";

/**
 * W2: the one route that may write archangel.yaml. Everything here exists to keep that safe:
 * - the path is fixed by the daemon's startup, never taken from a request;
 * - `apply` writes exactly the bytes a recent `preview` returned (identified by sha256), over exactly the file version the
 *   preview was made against (`baseSha256`);
 * - raising a limit, turning off shadow mode or enabling Scouts needs an explicit `confirmLoosen`;
 * - the write is audited under actor `host_config` BEFORE it happens (never `owner`, so it cannot reset the autonomy cap);
 * - atomic (temp file, fsync, rename, mode 0600) with a backup, last BACKUPS_KEEP kept.
 */

type Host = z.infer<typeof HostYamlSchema>;
export const BACKUPS_KEEP = 10;
export const PREVIEW_TTL_MS = 10 * 60_000;
const MAX_TEXT = 200_000;

export const sha256 = (s: string | Buffer): string => crypto.createHash("sha256").update(s).digest("hex");

export interface HostConfigDeps {
  /** The file the daemon was started with. Fixed at server start. */
  configPath: string;
  /** Writes one audit row with actor `host_config` (a separate writable handle: the dashboard's Ledger is read-only). Must throw on failure. */
  audit: (topic: string, payload: Record<string, unknown>, now: number) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface HostConfigRead {
  state: "ok" | "missing";
  /** Text of archangel.yaml. The schema is strict and holds no secrets; env values never appear here. */
  text: string | null;
  sha256: string | null;
}

export function readHostConfig(configPath: string): HostConfigRead {
  if (!fs.existsSync(configPath)) return { state: "missing", text: null, sha256: null };
  const text = fs.readFileSync(configPath, "utf8");
  return { state: "ok", text, sha256: sha256(text) };
}

const PROJECT_LOOSE_DEFAULT = HostYamlSchema.shape.projects.element.parse({ repo: "a/b" });
const HOST_DEFAULTS = HostYamlSchema.parse({ ownerUserId: 1, projects: [{ repo: "a/b" }] });

/** The effective value a project gets for a limit (its override, else the host's). */
function effective(host: Host, p: Host["projects"][number]) {
  return {
    steps: p.maxAutonomousStepsWithoutOwner ?? host.maxAutonomousStepsWithoutOwner,
    implement: p.maxImplementAttemptsPerThread ?? host.maxImplementAttemptsPerThread,
    revisions: p.maxRevisionsPerThread ?? host.maxRevisionsPerThread,
    rebases: p.maxRebasesPerThread ?? host.maxRebasesPerThread,
    merges: p.maxAutoMergesPerDay,
    promotions: p.scouts.maxAutoPromotionsPerDay,
    shadow: p.shadowMode,
    scouts: p.scouts.enabled,
  };
}

/** What `next` loosens relative to `prev` (a missing or unparsable previous file compares against the schema defaults). Pure. */
export function classifyLoosening(prev: Host | null, next: Host): string[] {
  const base = prev ?? HOST_DEFAULTS;
  const out: string[] = [];
  if (next.maxDailyUsd > base.maxDailyUsd) out.push(`maxDailyUsd ${base.maxDailyUsd} -> ${next.maxDailyUsd}`);
  const prevProjects = new Map(base.projects.map((p) => [p.repo, p]));
  for (const p of next.projects) {
    // A new project is compared with the strictest stance (shadow on, Scouts off) and the schema defaults for the caps.
    const old = prevProjects.get(p.repo);
    const prior = old ? effective(base, old) : effective(HOST_DEFAULTS, PROJECT_LOOSE_DEFAULT);
    const now = effective(next, p);
    const tag = (what: string, a: unknown, b: unknown) => out.push(`${p.repo}: ${what} ${String(a)} -> ${String(b)}`);
    if (now.steps > prior.steps) tag("maxAutonomousStepsWithoutOwner", prior.steps, now.steps);
    if (now.implement > prior.implement) tag("maxImplementAttemptsPerThread", prior.implement, now.implement);
    if (now.revisions > prior.revisions) tag("maxRevisionsPerThread", prior.revisions, now.revisions);
    if (now.rebases > prior.rebases) tag("maxRebasesPerThread", prior.rebases, now.rebases);
    if (now.merges > prior.merges) tag("maxAutoMergesPerDay", prior.merges, now.merges);
    if (now.promotions > prior.promotions) tag("maxAutoPromotionsPerDay", prior.promotions, now.promotions);
    if (!now.shadow && prior.shadow) tag("shadowMode", "on", "off");
    if (now.scouts && !prior.scouts) tag("scouts.enabled", "false", "true");
  }
  return out;
}

function parseHost(text: string): { ok: true; host: Host } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return { ok: false, errors: [`YAML: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const r = HostYamlSchema.safeParse(raw);
  return r.success ? { ok: true, host: r.data } : { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

/** Env-dependent checks (GitHub App id, key, ...) are reported, not enforced: the UI process is not the daemon's environment. */
function envWarnings(text: string, env: NodeJS.ProcessEnv): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-hostcheck-"));
  const file = path.join(dir, "archangel.yaml");
  try {
    fs.writeFileSync(file, text, { mode: 0o600 });
    loadProjectConfigs({ configPath: file, env });
    return [];
  } catch (e) {
    return [redactSecrets(e instanceof Error ? e.message : String(e), env).slice(0, 600)];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A small line diff (LCS), enough to show what changes in a config file of a few hundred lines. */
export function lineDiff(a: string, b: string): string {
  const x = a === "" ? [] : a.split("\n");
  const y = b === "" ? [] : b.split("\n");
  if (x.length * y.length > 4_000_000) return "(file too large to diff)";
  const t = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) t[i]![j] = x[i] === y[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) (i++, j++);
    else if (j < y.length && (i === x.length || t[i]![j + 1]! >= t[i + 1]![j]!)) out.push(`+ ${y[j++]}`);
    else out.push(`- ${x[i++]}`);
  }
  return out.join("\n");
}

const Body = z.object({
  mode: z.enum(["preview", "apply"]),
  /** sha256 of the file version this change is based on; null when there is no file yet. */
  baseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  rawText: z.string().max(MAX_TEXT),
  previewSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  confirmLoosen: z.boolean().optional(),
}).strict();

export interface PreviewResult {
  mode: "preview";
  valid: boolean;
  errors: string[];
  warnings: string[];
  loosening: string[];
  diff: string;
  baseSha256: string | null;
  /** Present only when valid: the hash `apply` must quote. */
  previewSha256?: string;
}
export interface ApplyResult {
  mode: "apply";
  path: string;
  backup: string | null;
  sha256: string;
  /** The daemon loaded the old file at start: host fields apply after it restarts. */
  restartRequired: true;
}

/** Stateful because `apply` must match a recent `preview` made by this process. */
export function makeHostConfigHandler(deps: HostConfigDeps) {
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const previews = new Map<string, { baseSha256: string | null; at: number }>();

  const current = () => {
    const r = readHostConfig(deps.configPath);
    const parsed = r.text === null ? null : parseHost(r.text);
    return { read: r, host: parsed && parsed.ok ? parsed.host : null };
  };

  function preview(b: z.infer<typeof Body>): PreviewResult {
    const cur = current();
    if (cur.read.sha256 !== b.baseSha256) throw new ProposeRefusal(409, "archangel.yaml changed on disk since you loaded it; reload and reapply your edit");
    const parsed = parseHost(b.rawText);
    const diff = lineDiff(cur.read.text ?? "", b.rawText);
    if (!parsed.ok) return { mode: "preview", valid: false, errors: parsed.errors, warnings: [], loosening: [], diff, baseSha256: b.baseSha256 };
    const hash = sha256(b.rawText);
    for (const [k, v] of previews) if (now() - v.at > PREVIEW_TTL_MS) previews.delete(k);
    previews.set(hash, { baseSha256: b.baseSha256, at: now() });
    return { mode: "preview", valid: true, errors: [], warnings: envWarnings(b.rawText, env), loosening: classifyLoosening(cur.host, parsed.host), diff, baseSha256: b.baseSha256, previewSha256: hash };
  }

  function apply(b: z.infer<typeof Body>): ApplyResult {
    const hash = sha256(b.rawText);
    if (b.previewSha256 !== hash) throw new ProposeRefusal(400, "apply must quote the previewSha256 of exactly the text previewed");
    const seen = previews.get(hash);
    if (!seen || now() - seen.at > PREVIEW_TTL_MS || seen.baseSha256 !== b.baseSha256) throw new ProposeRefusal(409, "no recent preview of this exact text: preview it again");
    const cur = current();
    if (cur.read.sha256 !== b.baseSha256) throw new ProposeRefusal(409, "archangel.yaml changed on disk since the preview; reload and reapply your edit");
    const parsed = parseHost(b.rawText);
    if (!parsed.ok) throw new ProposeRefusal(422, `archangel.yaml would be invalid: ${parsed.errors.join("; ")}`);
    const loosening = classifyLoosening(cur.host, parsed.host);
    if (loosening.length > 0 && b.confirmLoosen !== true) throw new ProposeRefusal(409, `this change loosens limits and needs confirmLoosen: ${loosening.join("; ")}`);

    const t = now();
    const dir = path.dirname(deps.configPath);
    const base = path.basename(deps.configPath);
    let backup: string | null = null;
    if (cur.read.text !== null) backup = path.join(dir, `${base}.bak-${t}`);
    // Audit first: a write that cannot be recorded is not made.
    deps.audit("host_config/apply", { path: deps.configPath, fromSha256: cur.read.sha256, toSha256: hash, loosening, backup }, t);
    if (backup) fs.copyFileSync(deps.configPath, backup);
    if (backup) fs.chmodSync(backup, 0o600);
    const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, b.rawText);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, deps.configPath);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    previews.delete(hash);
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.bak-`)).sort();
    for (const old of baks.slice(0, Math.max(0, baks.length - BACKUPS_KEEP))) fs.rmSync(path.join(dir, old), { force: true });
    return { mode: "apply", path: deps.configPath, backup, sha256: hash, restartRequired: true };
  }

  return (raw: unknown): PreviewResult | ApplyResult => {
    const parsed = Body.safeParse(raw);
    if (!parsed.success) throw new ProposeRefusal(400, `invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    return parsed.data.mode === "preview" ? preview(parsed.data) : apply(parsed.data);
  };
}
