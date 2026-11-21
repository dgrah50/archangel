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
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  labels: string[];
  changedFiles: string[];
  mergeableState?: string;
}

export interface GitHubClient {
  getInstallationToken(): Promise<string>;
  getRemoteUrlWithToken(): Promise<string>;
  listOpenIssuesByLabel(label: string): Promise<GitHubIssue[]>;
  verifyLabelActor(issueNumber: number, labelName: string, expectedOwnerId: number): Promise<boolean>;
  getBranchTipSha(branch: string): Promise<string>;
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
}

/**
 * Pure Node GitHub App REST client with RS256 JWT minting, cached installation tokens,
 * and ETag conditional requests (304 Not Modified does not consume rate limit).
 */
export class GitHubAppClient implements GitHubClient {
  private readonly cfg: GitHubAppConfig;
  private readonly apiBase: string;
  private cachedToken: { token: string; expiresAt: number } | null = null;
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

  async getInstallationToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60_000) {
      return this.cachedToken.token;
    }
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
    const body = (await res.json()) as { token: string; expires_at: string };
    this.cachedToken = {
      token: body.token,
      expiresAt: Date.parse(body.expires_at),
    };
    return body.token;
  }

  async getRemoteUrlWithToken(): Promise<string> {
    const token = await this.getInstallationToken();
    return `https://x-access-token:${token}@github.com/${this.cfg.owner}/${this.cfg.repo}.git`;
  }

  private async request<T>(
    method: string,
    endpoint: string,
    opts: { body?: unknown; useEtag?: boolean } = {},
  ): Promise<T> {
    const token = await this.getInstallationToken();
    const url = `${this.apiBase}${endpoint}`;
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
      if (cached) return cached.data as T;
    }
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${endpoint} failed (${res.status}): ${await res.text()}`);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    const data = (await res.json()) as T;
    if (method === "GET" && opts.useEtag) {
      const etag = res.headers.get("etag");
      if (etag) {
        this.etagCache.set(url, { etag, data });
      }
    }
    return data;
  }

  async listOpenIssuesByLabel(label: string): Promise<GitHubIssue[]> {
    const q = encodeURIComponent(label);
    const items = await this.request<Array<Record<string, unknown>>>(
      "GET",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/issues?state=open&labels=${q}&per_page=50`,
      { useEtag: true },
    );
    return items
      .filter((it) => !it.pull_request)
      .map((it) => {
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
      });
  }

  async verifyLabelActor(
    issueNumber: number,
    labelName: string,
    expectedOwnerId: number,
  ): Promise<boolean> {
    const events = await this.request<Array<Record<string, unknown>>>(
      "GET",
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
      this.request<Array<{ filename: string }>>(
        "GET",
        `/repos/${this.cfg.owner}/${this.cfg.repo}/pulls/${prNumber}/files?per_page=100`,
        { useEtag: false },
      ),
    ]);
    const head = (pr.head ?? {}) as Record<string, unknown>;
    const base = (pr.base ?? {}) as Record<string, unknown>;
    const labels = Array.isArray(pr.labels)
      ? (pr.labels as Array<{ name?: string }>).map((l) => l.name ?? "").filter(Boolean)
      : [];
    return {
      number: Number(pr.number),
      title: String(pr.title ?? ""),
      state: pr.state === "closed" ? "closed" : "open",
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
    const res = await this.request<{ check_runs: Array<Record<string, unknown>> }>(
      "GET",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
      { useEtag: false },
    );
    return (res.check_runs ?? []).map((cr) => {
      const app = (cr.app ?? {}) as { slug?: string };
      return {
        id: Number(cr.id),
        name: String(cr.name ?? ""),
        status: String(cr.status ?? "queued") as CheckStatus["status"],
        conclusion: cr.conclusion === null ? null : String(cr.conclusion),
        appSlug: app.slug ?? null,
      };
    });
  }

  async rerunCheckRun(checkRunId: number): Promise<void> {
    await this.request(
      "POST",
      `/repos/${this.cfg.owner}/${this.cfg.repo}/check-runs/${checkRunId}/rerequest`,
    );
  }

  async upsertRecapComment(issueOrPrNumber: number, body: string): Promise<void> {
    const comments = await this.request<Array<{ id: number; body?: string }>>(
      "GET",
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

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
