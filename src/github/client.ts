import crypto from "node:crypto";
import type { CheckStatus } from "../core/blockers.js";
import { RECAP_MARKER } from "../core/recap.js";

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
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  labels: string[];
  changedFiles: string[];
  mergeableState?: string;
}

export interface InstallationTokenMeta {
  token: string;
  expiresAt: number;
  permissions: Record<string, string>;
  repositorySelection?: string;
}

export interface GitHubClient {
  getInstallationToken(): Promise<string>;
  mintInstallationTokenWithMeta?(): Promise<InstallationTokenMeta>;
  getRemoteUrlWithToken(): Promise<string>;
  listOpenIssuesByLabel(label: string): Promise<GitHubIssue[]>;
  getIssue(issueNumber: number): Promise<GitHubIssue>;
  verifyLabelActor(issueNumber: number, labelName: string, expectedOwnerId: number): Promise<boolean>;
  getBranchTipSha(branch: string): Promise<string>;
  fileExistsAtRef?(ref: string, filePath: string): Promise<boolean>;
  listRepoLabels?(): Promise<string[]>;
  findPrByHeadBranch(branch: string): Promise<GitHubPr | null>;
  createPr(input: { title: string; body: string; head: string; base: string }): Promise<GitHubPr>;
  getPrLive(prNumber: number): Promise<GitHubPr>;
  getCheckRunsForRef(ref: string): Promise<Array<CheckStatus & { id: number }>>;
  rerunCheckRun(checkRunId: number): Promise<void>;
  upsertRecapComment(issueOrPrNumber: number, body: string): Promise<void>;
  postComment(issueOrPrNumber: number, body: string): Promise<void>;
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  squashMergePr(
    prNumber: number,
    expectedHeadSha: string,
    commitTitle: string,
  ): Promise<{ squashSha: string }>;
}

export interface GitHubAppConfig {
  owner: string;
  repo: string;
  appId: string;
  installationId: number;
  privateKeyPem: string;
  apiBaseUrl?: string;
}

interface EtagEntry {
  etag: string;
  data: unknown;
  nextUrl: string | null;
}

const MAX_PAGES = 20;

/**
 * Pure Node GitHub App REST client with RS256 JWT minting, cached installation tokens,
 * full `Link: rel="next"` pagination, check-run deduplication by highest `id`,
 * and ETag conditional requests (`304 Not Modified` consumes zero rate limit).
 */
export class GitHubAppClient implements GitHubClient {
  private readonly cfg: GitHubAppConfig;
  private readonly apiBase: string;
  private cachedToken: InstallationTokenMeta | null = null;
  private readonly etagCache = new Map<string, EtagEntry>();

  constructor(cfg: GitHubAppConfig) {
    this.cfg = cfg;
    this.apiBase = (cfg.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
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
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub App token mint failed (${res.status}): ${await res.text()}`);
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

    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (res.status === 304 && method === "GET" && opts.useEtag) {
      const cached = this.etagCache.get(url);
      if (cached) return { data: cached.data as T, nextUrl: cached.nextUrl };
    }
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${urlOrEndpoint} failed (${res.status}): ${await res.text()}`);
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

  async verifyLabelActor(
    issueNumber: number,
    labelName: string,
    expectedOwnerId: number,
  ): Promise<boolean> {
    const events = await this.requestAllPages<Record<string, unknown>>(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueNumber}/timeline?per_page=100`,
      { useEtag: false },
    );
    let lastActorId: number | null = null;
    for (const ev of events) {
      if (ev.event === "labeled") {
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
      if (err instanceof Error && err.message.includes("(404)")) {
        return false;
      }
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
      draft: Boolean(pr.draft),
      headRef: String(head.ref ?? ""),
      headSha: String(head.sha ?? ""),
      baseRef: String(base.ref ?? ""),
      baseSha: String(base.sha ?? ""),
      labels,
      changedFiles: files.map((f) => f.filename),
      mergeableState: pr.mergeable_state ? String(pr.mergeable_state) : undefined,
    };
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

    // Deduplicate by name, keeping the latest execution (highest check-run id — Codex #7 & Neon P0.4).
    const latestByName = new Map<string, CheckStatus & { id: number }>();
    for (const cr of runs) {
      const app = (cr.app ?? {}) as { slug?: string };
      const parsed: CheckStatus & { id: number } = {
        id: Number(cr.id),
        name: String(cr.name ?? ""),
        status: String(cr.status ?? "queued") as CheckStatus["status"],
        conclusion: cr.conclusion === null ? null : String(cr.conclusion),
        appSlug: app.slug ?? null,
      };
      const prev = latestByName.get(parsed.name);
      if (!prev || parsed.id >= prev.id) {
        latestByName.set(parsed.name, parsed);
      }
    }
    return [...latestByName.values()];
  }

  async rerunCheckRun(checkRunId: number): Promise<void> {
    await this.request(
      "POST",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/check-runs/${checkRunId}/rerequest`,
    );
  }

  async upsertRecapComment(issueOrPrNumber: number, body: string): Promise<void> {
    const comments = await this.requestAllPages<{ id: number; body?: string }>(
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues/${issueOrPrNumber}/comments?per_page=100`,
      { useEtag: false },
    );
    const existing = comments.find((c) => (c.body ?? "").includes(RECAP_MARKER));
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
      if (!(err instanceof Error && err.message.includes("(404)"))) {
        throw err;
      }
    }
  }

  async squashMergePr(
    prNumber: number,
    expectedHeadSha: string,
    commitTitle: string,
  ): Promise<{ squashSha: string }> {
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
