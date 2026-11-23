import { GATE_PROOF_ANNOTATION_TITLE, type GateProof } from "../gate/gate.js";
import crypto from "node:crypto";
import os from "node:os";
import { dedupeChecksByLatestId, type CheckStatus } from "../core/blockers.js";
import { tryParseJson } from "../core/json.js";
import { AGENT_DRAFT_PREFIX } from "../core/correction-draft.js";
import { RECAP_MARKER } from "../core/recap.js";
import { emit } from "../core/telemetry.js";
import type { TelemetryTags } from "../core/telemetry-events.js";

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  authorId: number;
  authorLogin: string;
  authorAssociation: string;
  labels: string[];
  updatedAt: string;
}

export interface GitHubPr {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha: string | null;
  /** GitHub user id of whoever merged the PR (absent when unmerged). */
  mergedBy?: number;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  labels: string[];
  changedFiles: string[];
  mergeableState?: string;
  /** GitHub's verdict on merging into base: false = conflicts, null = still being computed, undefined = not reported. */
  mergeable?: boolean | null;
}

export interface InstallationTokenMeta {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
  repositorySelection?: string;
}

export interface IssueComment {
  id: number;
  userId: number;
  isBot: boolean;
  body: string;
  createdAt: number;
}

export interface GitHubClient {
  getInstallationToken(): Promise<string>;
  listOwnerCommentsSince(issueOrPrNumber: number, ownerUserId: number, sinceMs: number): Promise<string[]>;
  /** Every comment (any author) strictly after `sinceMs`, oldest first, with author id and bot flag. */
  listCommentsSince(issueOrPrNumber: number, sinceMs: number): Promise<IssueComment[]>;
  closePr(prNumber: number): Promise<void>;
  /** Closes an issue (the bot closing an expired pitch). */
  closeIssue(issueNumber: number): Promise<void>;
  listOwnerReviewFeedbackSince(prNumber: number, ownerUserId: number, sinceMs: number): Promise<string[]>;
  mintInstallationTokenWithMeta?(): Promise<InstallationTokenMeta>;
  getRemoteUrlWithToken(): Promise<string>;
  listOpenIssuesByLabel(label: string): Promise<GitHubIssue[]>;
  getIssue(issueNumber: number): Promise<GitHubIssue>;
  /** True when the latest application of the label (strictly after `sinceMs`, when given) was by `expectedOwnerId`. */
  verifyLabelActor(issueNumber: number, labelName: string, expectedOwnerId: number, sinceMs?: number): Promise<boolean>;
  /** True only if the most recent `unlabeled` event for this label on the issue was made by `expectedOwnerId`. */
  verifyLabelRemovedBy(issueNumber: number, labelName: string, expectedOwnerId: number): Promise<boolean>;
  getBranchTipSha(branch: string): Promise<string>;
  fileExistsAtRef?(ref: string, filePath: string): Promise<boolean>;
  listRepoLabels?(): Promise<string[]>;
  findPrByHeadBranch(branch: string): Promise<GitHubPr | null>;
  createPr(input: { title: string; body: string; head: string; base: string }): Promise<GitHubPr>;
  /** PRs merged into `baseBranch` after `sinceMs` (the 100 most recently updated closed PRs), oldest first. */
  listMergedPrsSince(sinceMs: number, baseBranch: string): Promise<Array<{ number: number; mergedAt: number }>>;
  /** Published, non-draft releases after `sinceMs`, oldest first. */
  listReleasesSince(sinceMs: number): Promise<Array<{ tag: string; publishedAt: number }>>;
  /** Public repository search (read-only, not scoped to this repo). `query` is host-built from owner topics and fixed templates. */
  searchRepositories(query: string, sort: "updated" | "stars", limit: number): Promise<Array<{ fullName: string; url: string; pushedAt: string; description: string | null }>>;
  /** The latest published release of a public repository, or null when it has none. */
  getLatestRelease(fullName: string): Promise<{ tag: string; name: string | null; url: string; publishedAt: string; body: string | null } | null>;
  /** Star count of a public repository (read-only). */
  getRepoStars(fullName: string): Promise<number>;
  /** Open Dependabot alerts created after `sinceMs`, oldest first. Needs the App's `vulnerability_alerts` read permission. */
  listDependabotAlertsSince(sinceMs: number): Promise<Array<{ number: number; createdAt: number; severity: string; ghsaId: string }>>;
  createIssue?(input: { title: string; body: string; labels: string[] }): Promise<GitHubIssue>;
  getPrLive(prNumber: number): Promise<GitHubPr>;
  getCheckRunsForRef(ref: string): Promise<Array<CheckStatus & { id: number }>>;
  rerunCheckRun(checkRunId: number): Promise<void>;
  /** Reproduction-test output the Gate emitted as an annotation on its check run for `headSha`, or null. */
  getGateProof(checkRunId: number, headSha: string): Promise<GateProof | null>;
  /** The violations the Gate printed in its job log (the check run id is the job id), or [] when none can be read. */
  getGateViolations(jobId: number): Promise<string[]>;
  upsertRecapComment(issueOrPrNumber: number, body: string): Promise<void>;
  /** Creates or replaces the one comment that contains `marker`. */
  upsertMarkedComment(issueOrPrNumber: number, marker: string, body: string): Promise<void>;
  /** The only push that is not a factory branch: commits image files to the dedicated assets branch. Refuses any other ref or path. */
  publishAssets(input: AssetsPush): Promise<{ commitSha: string }>;
  postComment(issueOrPrNumber: number, body: string): Promise<void>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  squashMergePr(
    prNumber: number,
    expectedHeadSha: string,
    commitTitle: string,
  ): Promise<{ squashSha: string }>;
}

export class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubHttpError";
  }
}

export interface GitHubAppConfig {
  owner: string;
  repo: string;
  appId: string;
  installationId: number;
  privateKeyPem: string;
  apiBaseUrl?: string;
  /** Abort any single GitHub request that takes longer than this (default 30 s): a stalled socket must not wedge the tick. */
  requestTimeoutMs?: number;
}

interface EtagEntry {
  etag: string;
  data: unknown;
  nextUrl: string | null;
}

const MAX_PAGES = 20;

const ENDPOINT_CLASSES: Array<[RegExp, TelemetryTags<"github_call_ms">["endpoint"]]> = [
  [/\/(issues|labels)(\/|\?|$)/, "issues"],
  [/\/pulls(\/|\?|$)/, "pulls"],
  [/\/(check-runs|commits)(\/|\?|$)/, "checks"],
  [/\/git\//, "git"],
  [/\/contents\//, "contents"],
  [/\/(releases|dependabot)(\/|\?|$)/, "signals"],
];
function endpointClass(urlOrEndpoint: string): TelemetryTags<"github_call_ms">["endpoint"] {
  return ENDPOINT_CLASSES.find(([re]) => re.test(urlOrEndpoint))?.[1] ?? "other";
}
function statusClass(status: number): TelemetryTags<"github_call_ms">["status"] {
  return status === 429 ? "429" : status >= 500 ? "5xx" : status >= 400 ? "4xx" : "2xx";
}

/** The dedicated orphan branch for images embedded in PR descriptions and comments. It is not main and not a factory branch. */
export const ASSETS_REF = "refs/heads/archangel/assets";
const ASSET_PATH = /^(prs|pitches)\/\d{1,9}\/[0-9a-f]{64}\.png$/;
const ASSET_MAX_FILES = 3;
const ASSET_MAX_BYTES = 1024 * 1024;

export interface AssetsPush {
  ref: string;
  files: Array<{ path: string; bytes: Buffer }>;
  message: string;
}

/** What an assets push may touch; throws on anything else. Pure, so the narrowness is checked before any request is made. */
export function assertAssetsPush(input: AssetsPush): void {
  if (input.ref !== ASSETS_REF) throw new Error(`publishAssets only writes ${ASSETS_REF}, not ${input.ref}`);
  if (input.files.length < 1 || input.files.length > ASSET_MAX_FILES) throw new Error(`publishAssets takes 1 to ${ASSET_MAX_FILES} files`);
  for (const f of input.files) {
    if (!ASSET_PATH.test(f.path)) throw new Error(`publishAssets only writes prs/<n>/<sha256>.png or pitches/<n>/<sha256>.png, not ${f.path}`);
    if (f.bytes.length > ASSET_MAX_BYTES) throw new Error(`publishAssets file over ${ASSET_MAX_BYTES} bytes`);
  }
}

/**
 * Nothing sent to GitHub names this machine's home directory. Model text (an implementer's summary, a reviewer's finding, a
 * Scout's proposal) often cites files by their absolute path in a local workspace, and every write goes through `request`.
 */
const HOME_IN_JSON = JSON.stringify(os.homedir()).slice(1, -1);
function withoutHomeDir(json: string): string {
  return HOME_IN_JSON.length > 1 ? json.replaceAll(HOME_IN_JSON, "~") : json;
}

export class GitHubAppClient implements GitHubClient {
  private readonly cfg: GitHubAppConfig;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private cachedToken: InstallationTokenMeta | null = null;
  private readonly etagCache = new Map<string, EtagEntry>();

  constructor(cfg: GitHubAppConfig) {
    this.cfg = cfg;
    this.apiBase = (cfg.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.timeoutMs = cfg.requestTimeoutMs ?? 30_000;
  }

  private signAppJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(
      JSON.stringify({
        iat: now - 60,
        exp: now + 9 * 60,
        iss: this.cfg.appId,
      }),
    );
    const unsigned = `${header}.${payload}`;
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(unsigned);
    const sig = signer.sign(this.cfg.privateKeyPem);
    return `${unsigned}.${base64Url(sig)}`;
  }

  async mintInstallationTokenWithMeta(): Promise<InstallationTokenMeta> {
    const jwt = this.signAppJwt();
    const t0 = Date.now();
    const res = await fetch(
      `${this.apiBase}/app/installations/${this.cfg.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "archangel-factory/0.1",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    emit("github_call_ms", Date.now() - t0, { endpoint: "auth", status: statusClass(res.status) }, `${this.cfg.owner}/${this.cfg.repo}`);
    if (!res.ok) {
      throw new GitHubHttpError(res.status, `GitHub App token mint failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as {
      token: string;
      expires_at: string;
      permissions?: Record<string, string>;
      repository_selection?: string;
    };
    const meta: InstallationTokenMeta = {
      token: body.token,
      expiresAt: Date.parse(body.expires_at),
      permissions: body.permissions ?? {},
      repositorySelection: body.repository_selection,
    };
    this.cachedToken = meta;
    return meta;
  }

  async getInstallationToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 120_000) {
      return this.cachedToken.token;
    }
    const meta = await this.mintInstallationTokenWithMeta();
    return meta.token;
  }

  async getRemoteUrlWithToken(): Promise<string> {
    const token = await this.getInstallationToken();
    return `https://x-access-token:${token}@github.com/${this.cfg.owner}/${this.cfg.repo}.git`;
  }

  private async requestWithLink<T>(
    method: string,
    urlOrEndpoint: string,
    opts: { body?: unknown; useEtag?: boolean } = {},
  ): Promise<{ data: T; nextUrl: string | null }> {
    const token = await this.getInstallationToken();
    const url = urlOrEndpoint.startsWith("http") ? urlOrEndpoint : `${this.apiBase}${urlOrEndpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "archangel-factory/0.1",
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (method === "GET" && opts.useEtag) {
      const cached = this.etagCache.get(url);
      if (cached) {
        headers["If-None-Match"] = cached.etag;
      }
    }

    const t0 = Date.now();
    const repoSlug = `${this.cfg.owner}/${this.cfg.repo}`;
    const endpoint = endpointClass(urlOrEndpoint);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? withoutHomeDir(JSON.stringify(opts.body)) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      emit("github_call_ms", Date.now() - t0, { endpoint, status: "error" }, repoSlug);
      throw err;
    }
    emit("github_call_ms", Date.now() - t0, { endpoint, status: statusClass(res.status) }, repoSlug);

    if (res.status === 304 && method === "GET" && opts.useEtag) {
      const cached = this.etagCache.get(url);
      if (cached) return { data: cached.data as T, nextUrl: cached.nextUrl };
    }
    if (!res.ok) {
      throw new GitHubHttpError(res.status, `GitHub ${method} ${urlOrEndpoint} failed (${res.status}): ${await res.text()}`);
    }
    if (res.status === 204) {
      return { data: undefined as T, nextUrl: null };
    }
    const data = (await res.json()) as T;
    const nextUrl = parseNextLink(res.headers.get("link"));
    if (method === "GET" && opts.useEtag) {
      const etag = res.headers.get("etag");
      if (etag) {
        this.etagCache.set(url, { etag, data, nextUrl });
      }
    }
    return { data, nextUrl };
  }

  private async request<T>(
    method: string,
    endpoint: string,
    opts: { body?: unknown; useEtag?: boolean } = {},
  ): Promise<T> {
    const { data } = await this.requestWithLink<T>(method, endpoint, opts);
    return data;
  }

  private async requestAllPages<T>(
    endpoint: string,
    opts: { useEtag?: boolean; extract?: (page: unknown) => T[] } = {},
  ): Promise<T[]> {
    const all: T[] = [];
    let next: string | null = endpoint;
    let pages = 0;
    while (next && pages < MAX_PAGES) {
      const res: { data: unknown; nextUrl: string | null } = await this.requestWithLink<unknown>(
        "GET",
        next,
        { useEtag: opts.useEtag },
      );
      const items = opts.extract ? opts.extract(res.data) : (res.data as T[]);
      if (Array.isArray(items)) {
        all.push(...items);
      }
      next = res.nextUrl;
      pages++;
    }
    if (next) {
      throw new Error(`GitHub pagination exceeded safety limit (${MAX_PAGES} pages) on ${endpoint}`);
    }
    return all;
  }

  async listOpenIssuesByLabel(label: string): Promise<GitHubIssue[]> {
    const q = encodeURIComponent(label);
    const items = await this.requestAllPages<Record<string, unknown>>(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues?state=open&labels=${q}&per_page=100`,
      { useEtag: true },
    );
    return items.filter((it) => !it.pull_request).map(mapIssue);
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    const item = await this.request<Record<string, unknown>>(
      "GET",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueNumber}`,
      { useEtag: true },
    );
    return mapIssue(item);
  }

  async verifyLabelRemovedBy(issueNumber: number, labelName: string, expectedOwnerId: number): Promise<boolean> {
    const events = await this.requestAllPages<Record<string, unknown>>(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueNumber}/timeline?per_page=100`,
      { useEtag: false },
    );
    let lastActorId: number | null = null;
    for (const ev of events) {
      if (ev.event !== "unlabeled") continue;
      if (((ev.label ?? {}) as { name?: string }).name === labelName) lastActorId = Number(((ev.actor ?? {}) as { id?: number }).id ?? 0);
    }
    return lastActorId === expectedOwnerId;
  }

  async verifyLabelActor(
    issueNumber: number,
    labelName: string,
    expectedOwnerId: number,
    sinceMs?: number,
  ): Promise<boolean> {
    const events = await this.requestAllPages<Record<string, unknown>>(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueNumber}/timeline?per_page=100`,
      { useEtag: false },
    );
    let lastActorId: number | null = null;
    for (const ev of events) {
      if (ev.event === "labeled" && (sinceMs === undefined || Date.parse(String(ev.created_at ?? "")) > sinceMs)) {
        const lbl = (ev.label ?? {}) as { name?: string };
        const actor = (ev.actor ?? {}) as { id?: number };
        if (lbl.name === labelName) {
          lastActorId = Number(actor.id ?? 0);
        }
      }
    }
    return lastActorId === expectedOwnerId;
  }

  async getBranchTipSha(branch: string): Promise<string> {
    const ref = await this.request<{ object: { sha: string } }>(
      "GET",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
      { useEtag: true },
    );
    return ref.object.sha;
  }

  async fileExistsAtRef(ref: string, filePath: string): Promise<boolean> {
    try {
      await this.request(
        "GET",
        `/repos/${this.cfg.owner}/${this.cfg.repo}/contents/${filePath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}?ref=${encodeURIComponent(ref)}`,
        { useEtag: false },
      );
      return true;
    } catch (err) {
      if (err instanceof GitHubHttpError && err.status === 404) {
        return false;
      }
      throw err;
    }
  }

  /** UTF-8 content of a file at a ref, or null when it does not exist. */
  async readFileAtRef(ref: string, filePath: string): Promise<string | null> {
    try {
      const res = await this.request<{ content?: string; encoding?: string }>(
        "GET",
        `/repos/${this.cfg.owner}/${this.cfg.repo}/contents/${filePath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}?ref=${encodeURIComponent(ref)}`,
        { useEtag: false },
      );
      // A file the Contents API will not inline (over 1 MB, a submodule, a directory) is not a missing file.
      if (res.encoding !== "base64" || typeof res.content !== "string") {
        throw new Error(`GitHub returned ${filePath} at ${ref} without inline content (encoding ${String(res.encoding)}); cannot read it`);
      }
      return Buffer.from(res.content, "base64").toString("utf8");
    } catch (err) {
      if (err instanceof GitHubHttpError && err.status === 404) return null;
      throw err;
    }
  }

  async listRepoLabels(): Promise<string[]> {
    const items = await this.requestAllPages<{ name?: string }>(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/labels?per_page=100`,
      { useEtag: false },
    );
    return items.map((l) => l.name ?? "").filter(Boolean);
  }

  async findPrByHeadBranch(branch: string): Promise<GitHubPr | null> {
    const head = encodeURIComponent(`${this.cfg.owner}:${branch}`);
    const prs = await this.request<Array<Record<string, unknown>>>(
      "GET",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/pulls?state=open&head=${head}&per_page=5`,
      { useEtag: false },
    );
    const first = prs[0];
    if (!first) return null;
    return this.getPrLive(Number(first.number));
  }

  async createPr(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<GitHubPr> {
    const existing = await this.findPrByHeadBranch(input.head);
    if (existing) return existing;
    const created = await this.request<Record<string, unknown>>(
      "POST",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/pulls`,
      { body: input },
    );
    return this.getPrLive(Number(created.number));
  }

  async listMergedPrsSince(sinceMs: number, baseBranch: string): Promise<Array<{ number: number; mergedAt: number }>> {
    const items = await this.request<Array<Record<string, unknown>>>(
      "GET",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&base=${encodeURIComponent(baseBranch)}`,
    );
    return items
      .flatMap((p) => (typeof p.merged_at === "string" ? [{ number: Number(p.number), mergedAt: Date.parse(p.merged_at) }] : []))
      .filter((p) => p.mergedAt > sinceMs)
      .sort((a, b) => a.mergedAt - b.mergedAt);
  }

  async listReleasesSince(sinceMs: number): Promise<Array<{ tag: string; publishedAt: number }>> {
    const items = await this.request<Array<Record<string, unknown>>>("GET", `/repos/${this.cfg.owner}/${this.cfg.repo}/releases?per_page=30`);
    return items
      .flatMap((r) => (r.draft !== true && typeof r.published_at === "string" ? [{ tag: String(r.tag_name), publishedAt: Date.parse(r.published_at) }] : []))
      .filter((r) => r.publishedAt > sinceMs)
      .sort((a, b) => a.publishedAt - b.publishedAt);
  }

  async searchRepositories(query: string, sort: "updated" | "stars", limit: number) {
    const res = await this.request<{ items?: Array<Record<string, unknown>> }>(
      "GET",
      `/search/repositories?q=${encodeURIComponent(query)}&sort=${sort}&order=desc&per_page=${Math.min(Math.max(limit, 1), 10)}`,
    );
    return (res.items ?? []).map((r) => ({
      fullName: String(r.full_name),
      url: String(r.html_url),
      pushedAt: String(r.pushed_at),
      description: typeof r.description === "string" ? r.description : null,
    }));
  }

  async getRepoStars(fullName: string): Promise<number> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error("not a repository full name");
    const r = await this.request<Record<string, unknown>>("GET", `/repos/${fullName}`);
    return typeof r.stargazers_count === "number" ? r.stargazers_count : 0;
  }

  async getLatestRelease(fullName: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new Error("not a repository full name");
    try {
      const r = await this.request<Record<string, unknown>>("GET", `/repos/${fullName}/releases/latest`);
      return {
        tag: String(r.tag_name),
        name: typeof r.name === "string" ? r.name : null,
        url: String(r.html_url),
        publishedAt: String(r.published_at),
        body: typeof r.body === "string" ? r.body : null,
      };
    } catch (err) {
      if (err instanceof GitHubHttpError && err.status === 404) return null;
      throw err;
    }
  }

  async listDependabotAlertsSince(sinceMs: number): Promise<Array<{ number: number; createdAt: number; severity: string; ghsaId: string }>> {
    const items = await this.request<Array<Record<string, unknown>>>(
      "GET",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/dependabot/alerts?state=open&sort=created&direction=desc&per_page=50`,
    );
    return items
      .map((a) => {
        const adv = (a.security_advisory ?? {}) as Record<string, unknown>;
        return { number: Number(a.number), createdAt: Date.parse(String(a.created_at)), severity: String(adv.severity), ghsaId: String(adv.ghsa_id) };
      })
      .filter((a) => a.createdAt > sinceMs)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<GitHubIssue> {
    const created = await this.request<Record<string, unknown>>(
      "POST",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues`,
      { body: input },
    );
    return mapIssue(created);
  }

  async getPrLive(prNumber: number): Promise<GitHubPr> {
    const [pr, files] = await Promise.all([
      this.request<Record<string, unknown>>(
        "GET",
        `/repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${prNumber}`,
        { useEtag: false },
      ),
      this.requestAllPages<{ filename: string }>(
        `/repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${prNumber}/files?per_page=100`,
        { useEtag: false },
      ),
    ]);
    const head = (pr.head ?? {}) as Record<string, unknown>;
    const base = (pr.base ?? {}) as Record<string, unknown>;
    const labels = Array.isArray(pr.labels)
      ? (pr.labels as Array<{ name?: string }>).map((l) => l.name ?? "").filter(Boolean)
      : [];
    const merged = Boolean(pr.merged) || pr.merged_at !== null && pr.merged_at !== undefined;
    return {
      number: Number(pr.number),
      title: String(pr.title ?? ""),
      state: pr.state === "closed" ? "closed" : "open",
      merged,
      mergeCommitSha: pr.merge_commit_sha ? String(pr.merge_commit_sha) : null,
      ...(typeof (pr.merged_by as { id?: unknown } | null | undefined)?.id === "number" ? { mergedBy: (pr.merged_by as { id: number }).id } : {}),
      draft: Boolean(pr.draft),
      headRef: String(head.ref ?? ""),
      headSha: String(head.sha ?? ""),
      baseRef: String(base.ref ?? ""),
      baseSha: String(base.sha ?? ""),
      labels,
      changedFiles: files.map((f) => f.filename),
      mergeableState: pr.mergeable_state ? String(pr.mergeable_state) : undefined,
      mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : pr.mergeable === null ? null : undefined,
    };
  }

  async getGateProof(checkRunId: number, headSha: string): Promise<GateProof | null> {
    const annotations = await this.requestAllPages<{ title?: string; message?: string }>(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/check-runs/${checkRunId}/annotations?per_page=100`,
      { useEtag: false },
    );
    // Exactly one proof annotation, or it is ambiguous (possible forgery) and treated as not captured.
    const proofs = annotations.filter((a) => a.title === GATE_PROOF_ANNOTATION_TITLE);
    const ann = proofs.length === 1 ? proofs[0] : undefined;
    if (!ann?.message) return null;
    const res = tryParseJson(ann.message);
    if (!res.ok || typeof res.value !== "object" || res.value === null) return null;
    const parsed = res.value as Record<string, unknown>;
    if (parsed.head_sha !== headSha) return null;
    const out: GateProof = {};
    if (typeof parsed.base_output === "string") out.base_output = parsed.base_output;
    if (typeof parsed.head_output === "string") out.head_output = parsed.head_output;
    const j = parsed.junit as { base_failed?: unknown; head_passed?: unknown } | undefined;
    if (j && Array.isArray(j.base_failed) && Array.isArray(j.head_passed)) {
      const ids = (a: unknown[]) => a.filter((x): x is string => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 160));
      out.junit = { base_failed: ids(j.base_failed), head_passed: ids(j.head_passed) };
    }
    return out;
  }

  async getGateViolations(jobId: number): Promise<string[]> {
    const token = await this.getInstallationToken();
    const res = await fetch(`${this.apiBase}/repos/${this.cfg.owner}/${this.cfg.repo}/actions/jobs/${jobId}/logs`, {
      headers: { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "archangel-factory/0.1" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) return [];
    return violationsFromGateLog(await res.text());
  }

  async getCheckRunsForRef(ref: string): Promise<Array<CheckStatus & { id: number }>> {
    const runs = await this.requestAllPages<Record<string, unknown>>(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
      {
        useEtag: false,
        extract: (page) =>
          ((page as { check_runs?: Array<Record<string, unknown>> }).check_runs ?? []),
      },
    );

    const parsed = runs.map((cr) => {
      const app = (cr.app ?? {}) as { slug?: string };
      const out = (cr.output ?? {}) as { title?: string | null; summary?: string | null; text?: string | null };
      return {
        output: [out.title, out.summary, out.text].filter((x): x is string => Boolean(x)).join("\n").slice(0, 6000),
        id: Number(cr.id),
        name: String(cr.name ?? ""),
        status: String(cr.status ?? "queued") as CheckStatus["status"],
        conclusion: cr.conclusion === null ? null : String(cr.conclusion),
        appSlug: app.slug ?? null,
      };
    });
    return [...dedupeChecksByLatestId(parsed).values()];
  }

  async rerunCheckRun(checkRunId: number): Promise<void> {
    await this.request(
      "POST",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/check-runs/${checkRunId}/rerequest`,
    );
  }

  async upsertRecapComment(issueOrPrNumber: number, body: string): Promise<void> {
    await this.upsertMarkedComment(issueOrPrNumber, RECAP_MARKER, body);
  }

  async upsertMarkedComment(issueOrPrNumber: number, marker: string, body: string): Promise<void> {
    const comments = await this.requestAllPages<{ id: number; body?: string }>(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueOrPrNumber}/comments?per_page=100`,
      { useEtag: false },
    );
    const existing = comments.find((c) => (c.body ?? "").includes(marker));
    if (existing) {
      await this.request(
        "PATCH",
        `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/comments/${existing.id}`,
        { body: { body } },
      );
      return;
    }
    await this.postComment(issueOrPrNumber, body);
  }

  /**
   * Adds the files to `archangel/assets` in one commit and returns its sha, for commit-pinned blob URLs. The branch is created as an
   * orphan on first use, so it shares no history with main. Plain (non-force) ref updates: a concurrent writer makes this fail, not clobber.
   */
  async publishAssets(input: AssetsPush): Promise<{ commitSha: string }> {
    assertAssetsPush(input);
    const base = `/repos/${this.cfg.owner}/${this.cfg.repo}/git`;
    const branch = ASSETS_REF.slice("refs/".length);
    let parent: { sha: string; tree: string } | null = null;
    try {
      const ref = await this.request<{ object: { sha: string } }>("GET", `${base}/ref/${branch}`, { useEtag: false });
      const commit = await this.request<{ tree: { sha: string } }>("GET", `${base}/commits/${ref.object.sha}`, { useEtag: false });
      parent = { sha: ref.object.sha, tree: commit.tree.sha };
    } catch (err) {
      if (!(err instanceof GitHubHttpError && err.status === 404)) throw err;
    }
    const tree: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    for (const f of input.files) {
      const blob = await this.request<{ sha: string }>("POST", `${base}/blobs`, { body: { content: f.bytes.toString("base64"), encoding: "base64" } });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = await this.request<{ sha: string }>("POST", `${base}/trees`, { body: { ...(parent ? { base_tree: parent.tree } : {}), tree } });
    const commit = await this.request<{ sha: string }>("POST", `${base}/commits`, { body: { message: input.message, tree: newTree.sha, parents: parent ? [parent.sha] : [] } });
    if (parent) await this.request("PATCH", `${base}/refs/${branch}`, { body: { sha: commit.sha, force: false } });
    else await this.request("POST", `${base}/refs`, { body: { ref: ASSETS_REF, sha: commit.sha } });
    return { commitSha: commit.sha };
  }

  /** Bodies of comments written by `ownerUserId` strictly after `sinceMs`, oldest first. */
  async listOwnerCommentsSince(issueOrPrNumber: number, ownerUserId: number, sinceMs: number): Promise<string[]> {
    const comments = await this.requestAllPages<{ body?: string; created_at?: string; user?: { id?: number } | null }>(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueOrPrNumber}/comments?per_page=100`,
      { useEtag: false },
    );
    return comments
      .filter((c) => c.user?.id === ownerUserId && Date.parse(c.created_at ?? "") > sinceMs && (c.body ?? "").trim())
      .sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""))
      .map((c) => (c.body ?? "").trim());
  }

  async listCommentsSince(issueOrPrNumber: number, sinceMs: number): Promise<IssueComment[]> {
    const comments = await this.requestAllPages<{
      id?: number;
      body?: string;
      created_at?: string;
      user?: { id?: number; type?: string } | null;
    }>(`/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueOrPrNumber}/comments?per_page=100`, { useEtag: false });
    return comments
      .map((c) => ({
        id: Number(c.id),
        userId: Number(c.user?.id ?? 0),
        isBot: c.user?.type === "Bot",
        body: c.body ?? "",
        createdAt: Date.parse(c.created_at ?? ""),
      }))
      .filter((c) => c.createdAt > sinceMs)
      .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.request("PATCH", `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueNumber}`, {
      body: { state: "closed", state_reason: "not_planned" },
    });
  }

  async closePr(prNumber: number): Promise<void> {
    await this.request("PATCH", `/repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${prNumber}`, {
      body: { state: "closed" },
    });
  }

  /**
   * The owner's PR review feedback after `sinceMs`, oldest first: inline diff comments as
   * `path:line: body`, and non-empty review summaries with their state.
   */
  async listOwnerReviewFeedbackSince(prNumber: number, ownerUserId: number, sinceMs: number): Promise<string[]> {
    const base = `/repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${prNumber}`;
    const inline = await this.requestAllPages<{
      body?: string;
      path?: string;
      line?: number | null;
      original_line?: number | null;
      created_at?: string;
      user?: { id?: number } | null;
    }>(`${base}/comments?per_page=100`, { useEtag: false });
    const reviews = await this.requestAllPages<{
      body?: string | null;
      state?: string;
      submitted_at?: string | null;
      user?: { id?: number } | null;
    }>(`${base}/reviews?per_page=100`, { useEtag: false });
    const items: Array<{ at: number; text: string }> = [];
    for (const c of inline) {
      const at = Date.parse(c.created_at ?? "");
      const body = (c.body ?? "").trim();
      if (c.user?.id !== ownerUserId || !(at > sinceMs) || !body) continue;
      const line = c.line ?? c.original_line;
      items.push({ at, text: `${c.path ?? "?"}${line ? `:${line}` : ""}: ${body}` });
    }
    for (const r of reviews) {
      const at = Date.parse(r.submitted_at ?? "");
      const body = (r.body ?? "").trim();
      if (r.user?.id !== ownerUserId || !(at > sinceMs) || !body) continue;
      items.push({ at, text: `Review (${(r.state ?? "COMMENTED").toLowerCase().replace(/_/g, " ")}): ${body}` });
    }
    return items.sort((a, b) => a.at - b.at).map((i) => i.text);
  }

  async postComment(issueOrPrNumber: number, body: string): Promise<void> {
    await this.request(
      "POST",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueOrPrNumber}/comments`,
      { body: { body } },
    );
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.request(
      "POST",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueNumber}/labels`,
      { body: { labels } },
    );
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.request(
        "DELETE",
        `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      );
    } catch (err) {
      if (!(err instanceof GitHubHttpError && err.status === 404)) {
        throw err;
      }
    }
  }

  async squashMergePr(
    prNumber: number,
    expectedHeadSha: string,
    commitTitle: string,
  ): Promise<{ squashSha: string }> {
    const pr = await this.request<{ head?: { ref?: string } }>(
      "GET",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${prNumber}`,
      { useEtag: false },
    );
    const headRef = String(pr.head?.ref ?? "");
    if (headRef.startsWith(AGENT_DRAFT_PREFIX)) {
      throw new Error(`Refusing to merge PR #${prNumber}: head ref ${headRef} is a machine draft (${AGENT_DRAFT_PREFIX}*); only the owner merges it, by hand`);
    }
    const res = await this.request<{ sha: string; merged: boolean }>(
      "PUT",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${prNumber}/merge`,
      {
        body: {
          commit_title: commitTitle,
          sha: expectedHeadSha,
          merge_method: "squash",
        },
      },
    );
    if (!res.merged) {
      throw new Error(`PR #${prNumber} merge returned merged=false`);
    }
    return { squashSha: res.sha };
  }
}

function mapIssue(it: Record<string, unknown>): GitHubIssue {
  const user = (it.user ?? {}) as Record<string, unknown>;
  const labels = Array.isArray(it.labels)
    ? (it.labels as Array<{ name?: string }>).map((l) => l.name ?? "").filter(Boolean)
    : [];
  return {
    number: Number(it.number),
    title: String(it.title ?? ""),
    body: String(it.body ?? ""),
    state: it.state === "closed" ? "closed" : "open",
    authorId: Number(user.id ?? 0),
    authorLogin: String(user.login ?? ""),
    authorAssociation: String(it.author_association ?? ""),
    labels,
    updatedAt: String(it.updated_at ?? ""),
  };
}

/** The `violations` of the pretty-printed Gate report in a job log (lines carry a timestamp prefix), or [] when absent or malformed. */
export function violationsFromGateLog(log: string): string[] {
  const lines = log.split("\n").map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, "").replace(/\r$/, ""));
  const at = lines.findIndex((l) => l.startsWith('  "violations"'));
  if (at < 0) return [];
  let start = at;
  while (start >= 0 && lines[start] !== "{") start--;
  const end = lines.indexOf("}", at);
  if (start < 0 || end < 0) return [];
  const res = tryParseJson(lines.slice(start, end + 1).join("\n"));
  if (!res.ok || typeof res.value !== "object" || res.value === null) return [];
  const v = (res.value as { violations?: unknown }).violations;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m && m[1]) return m[1];
  }
  return null;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
