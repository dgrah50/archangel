import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GateProof } from "../../src/gate/gate.js";
import type { CheckStatus } from "../../src/core/blockers.js";
import type { GitHubClient, GitHubIssue, GitHubPr } from "../../src/github/client.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export class FakeGitHub implements GitHubClient {
  issues = new Map<number, GitHubIssue>();
  labelActors = new Map<string, number>();
  prs = new Map<number, GitHubPr>();
  checks = new Map<string, Array<CheckStatus & { id: number }>>();
  comments = new Map<number, string[]>();
  authoredComments = new Map<number, Array<{ userId: number; createdAt: number; body: string }>>();
  rerunCalls: number[] = [];
  nextPrNumber = 100;

  constructor(private readonly remoteBare: string) {}

  closedPrs: number[] = [];
  nextCommentId = 1000;
  /** Posts a comment as `userId` (use `isBot` to mimic an App/bot author) and returns its id. */
  addComment(n: number, userId: number, body: string, createdAt = Date.now(), isBot = false): number {
    const id = this.nextCommentId++;
    const list = this.authoredComments.get(n) ?? [];
    list.push({ userId, createdAt, body, id, isBot } as never);
    this.authoredComments.set(n, list);
    return id;
  }
  async listCommentsSince(n: number, sinceMs: number) {
    return ((this.authoredComments.get(n) ?? []) as unknown as Array<{ id?: number; isBot?: boolean; userId: number; createdAt: number; body: string }>)
      .filter((c) => c.createdAt > sinceMs)
      .map((c) => ({ id: c.id ?? 0, userId: c.userId, isBot: Boolean(c.isBot), body: c.body, createdAt: c.createdAt }));
  }
  async closePr(prNumber: number): Promise<void> {
    this.closedPrs.push(prNumber);
    const pr = this.prs.get(prNumber);
    if (pr) pr.state = "closed";
  }
  async getInstallationToken(): Promise<string> {
    return "fake-install-token";
  }
  reviewFeedback = new Map<number, Array<{ userId: number; createdAt: number; text: string }>>();
  async listOwnerReviewFeedbackSince(n: number, ownerUserId: number, sinceMs: number): Promise<string[]> {
    return (this.reviewFeedback.get(n) ?? [])
      .filter((c) => c.userId === ownerUserId && c.createdAt > sinceMs)
      .map((c) => c.text);
  }
  async listOwnerCommentsSince(n: number, ownerUserId: number, sinceMs: number): Promise<string[]> {
    return (this.authoredComments.get(n) ?? [])
      .filter((c) => c.userId === ownerUserId && c.createdAt > sinceMs)
      .map((c) => c.body);
  }
  async getRemoteUrlWithToken(): Promise<string> {
    return this.remoteBare;
  }
  async listOpenIssuesByLabel(label: string): Promise<GitHubIssue[]> {
    return [...this.issues.values()].filter((i) => i.state === "open" && i.labels.includes(label));
  }
  async getIssue(issueNumber: number): Promise<GitHubIssue> {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found`);
    return { ...issue, labels: [...issue.labels] };
  }
  async verifyLabelActor(issueNumber: number, labelName: string, expectedOwnerId: number): Promise<boolean> {
    return this.labelActors.get(`${issueNumber}:${labelName}`) === expectedOwnerId;
  }
  async getBranchTipSha(branch: string): Promise<string> {
    return git(this.remoteBare, ["rev-parse", `refs/heads/${branch}`]);
  }
  async findPrByHeadBranch(branch: string): Promise<GitHubPr | null> {
    return [...this.prs.values()].find((p) => p.state === "open" && p.headRef === branch) ?? null;
  }
  async createPr(input: { title: string; body: string; head: string; base: string }): Promise<GitHubPr> {
    const existing = await this.findPrByHeadBranch(input.head);
    if (existing) return existing;
    const headSha = await this.getBranchTipSha(input.head);
    const baseSha = await this.getBranchTipSha(input.base);
    const files = git(this.remoteBare, ["diff", "--name-only", baseSha, headSha])
      .split("\n")
      .filter(Boolean);
    const pr: GitHubPr = {
      number: this.nextPrNumber++,
      title: input.title,
      state: "open",
      merged: false,
      mergeCommitSha: null,
      draft: false,
      headRef: input.head,
      headSha,
      baseRef: input.base,
      baseSha,
      labels: [],
      changedFiles: files,
    };
    this.prs.set(pr.number, pr);
    return pr;
  }
  async getPrLive(prNumber: number): Promise<GitHubPr> {
    const pr = this.prs.get(prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found`);
    if (pr.state === "open") {
      pr.headSha = await this.getBranchTipSha(pr.headRef);
      pr.changedFiles = git(this.remoteBare, ["diff", "--name-only", pr.baseSha, pr.headSha])
        .split("\n")
        .filter(Boolean);
    }
    return { ...pr, labels: [...pr.labels], changedFiles: [...pr.changedFiles] };
  }
  async getCheckRunsForRef(ref: string): Promise<Array<CheckStatus & { id: number }>> {
    return this.checks.get(ref) ?? [];
  }
  async rerunCheckRun(checkRunId: number): Promise<void> {
    this.rerunCalls.push(checkRunId);
  }
  gateProofs = new Map<string, GateProof>();
  async getGateProof(_checkRunId: number, headSha: string): Promise<GateProof | null> {
    return this.gateProofs.get(headSha) ?? null;
  }
  async upsertRecapComment(issueOrPrNumber: number, body: string): Promise<void> {
    const list = this.comments.get(issueOrPrNumber) ?? [];
    list.push(body);
    this.comments.set(issueOrPrNumber, list);
  }
  async postComment(issueOrPrNumber: number, body: string): Promise<void> {
    await this.upsertRecapComment(issueOrPrNumber, body);
  }
  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (issue) issue.labels = [...new Set([...issue.labels, ...labels])];
  }
  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (issue) issue.labels = issue.labels.filter((l) => l !== label);
  }
  async squashMergePr(
    prNumber: number,
    expectedHeadSha: string,
    commitTitle: string,
  ): Promise<{ squashSha: string }> {
    const pr = await this.getPrLive(prNumber);
    if (pr.headSha !== expectedHeadSha) {
      throw new Error(`Head SHA mismatch: expected ${expectedHeadSha}, got ${pr.headSha}`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-merge-"));
    try {
      git(tmp, ["clone", this.remoteBare, "."]);
      git(tmp, ["config", "user.name", "GitHub"]);
      git(tmp, ["config", "user.email", "noreply@github.com"]);
      git(tmp, ["checkout", "main"]);
      git(tmp, ["merge", "--squash", expectedHeadSha]);
      git(tmp, ["commit", "-m", commitTitle]);
      git(tmp, ["push", "origin", "main"]);
      const squashSha = git(tmp, ["rev-parse", "HEAD"]);
      pr.state = "closed";
      pr.merged = true;
      pr.mergeCommitSha = squashSha;
      return { squashSha };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
}
