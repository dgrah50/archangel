import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import type { Notifier } from "../src/core/notifier.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { workflowJson, workflowFile } from "./helpers/workflow.js";

async function run(policy: string | null) {
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-policy-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(seed);
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@example.com"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
  if (policy !== null) {
    fs.mkdirSync(path.join(seed, ".agents"));
    fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), policy);
  }
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  git(root, ["clone", "--bare", seed, remoteBare]);
  const github = new FakeGitHub(remoteBare);
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
  const notes: Array<{ title: string; decisionClass: string }> = [];
  const notifier: Notifier = { async notifyNeedsYou(i) { notes.push(i); }, async sendDigest() {} };
  let calls = 0;
  const implementer: Implementer = { async run() { calls++; return { summary: "", costUsd: 0, transcriptPath: null, aborted: true }; } };
  const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
  const cfg = ConfigSchema.parse({
    githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake",
  });
  github.issues.set(5, {
    number: 5, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o",
    authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString(),
  });
  github.labelActors.set("5:ready-for-agent", 999);
  const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });
  try {
    await reconciler.tick(Date.now(), { waitForAttempts: true });
    await reconciler.tick(Date.now(), { waitForAttempts: true });
    return { calls, notes, thread: ledger.getThread(5)};
  } finally {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe("repo policy is required (fail closed, no host fallback)", () => {
  it("takes no work and notifies once when .agents/archangel.json is missing", async () => {
    const r = await run(null);
    expect(r.calls).toBe(0);
    expect(r.thread).toBeNull();
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]!.decisionClass).toBe("owner signoff");
  });

  it("takes no work when the policy has a typo'd key", async () => {
    const r = await run(JSON.stringify({ testCommand: "go test ./..." }));
    expect(r.calls).toBe(0);
    expect(r.thread).toBeNull();
    expect(r.notes).toHaveLength(1);
  });

  it("works normally with a valid policy", async () => {
    const r = await run(workflowJson());
    expect(r.thread).not.toBeNull();
    expect(r.notes.filter((n) => n.title.includes("repo policy"))).toHaveLength(0);
  });

  it("takes no work for a pre-version-1 file (no compatibility reader)", async () => {
    const r = await run(JSON.stringify({ testFileGlobs: ["**/*_test.go"], testCmd: "go test ./..." }));
    expect(r.calls).toBe(0);
    expect(r.thread).toBeNull();
    expect(r.notes).toHaveLength(1);
  });

  it.each([
    ["Gate only", ["Gate"]],
    ["no Gate", ["Test"]],
    ["none", []],
  ])("takes no work when requiredChecks is %s (landing could never see main green)", async (_n, requiredChecks) => {
    const r = await run(JSON.stringify(workflowFile([], { requiredChecks })));
    expect(r.calls).toBe(0);
    expect(r.thread).toBeNull();
    expect(r.notes).toHaveLength(1);
  });

  it("stamps new Threads with the workflow file hash", async () => {
    const r = await run(workflowJson());
    expect(r.thread?.workflowSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("post-merge monitoring does not depend on the current workflow", () => {
  it("still detects a red main after the workflow became invalid, using the checks recorded at merge time", async () => {
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-postmerge-"));
    const seed = path.join(root, "seed");
    const remoteBare = path.join(root, "remote.git");
    fs.mkdirSync(seed);
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.name", "T"]);
    git(seed, ["config", "user.email", "t@example.com"]);
    fs.writeFileSync(path.join(seed, "app.go"), "package demo\n"); // no .agents/archangel.json: workflow is missing
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "initial"]);
    const mainSha = git(seed, ["rev-parse", "HEAD"]);
    git(root, ["clone", "--bare", seed, remoteBare]);
    const github = new FakeGitHub(remoteBare);
    github.checks.set(mainSha, [
      { id: 11, name: "Test", status: "completed", conclusion: "failure", appSlug: "github-actions" } as never,
    ]);
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
    const notifier: Notifier = { async notifyNeedsYou() {}, async sendDigest() {} };
    const implementer: Implementer = { async run() { return { summary: "", costUsd: 0, transcriptPath: null, aborted: true }; } };
    const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
    const cfg = ConfigSchema.parse({
      githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake",
    });
    try {
      ledger.upsertThread({ issueNumber: 5, title: "t", themeLabel: null, bodySha256: "b", phase: { kind: "done", outcome: "merged" }, mode: "autonomous", now: 1 });
      const merge = ledger.recordMerge({ issueNumber: 5, prNumber: 9, headSha: "h", squashSha: mainSha, shadowOnly: false, mainRequired: ["Test"], now: 1 });
      expect(ledger.getMerge(merge.id)!.mainRequired).toEqual(["Test"]);
      const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });
      await reconciler.tick(Date.now(), { waitForAttempts: true });
      // Red check seen: the watch moved on (rerun requested), proving the recorded list was used.
      expect(ledger.getMerge(merge.id)!.mainWatch.kind).not.toBe("watching");
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("the repo-policy Needs You is sent once per broken main commit, durably", () => {
  async function world(policy: string | null) {
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-notice-"));
    const seed = path.join(root, "seed");
    const remoteBare = path.join(root, "remote.git");
    fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
    git(seed, ["init", "-b", "main"]);
    git(seed, ["config", "user.name", "T"]);
    git(seed, ["config", "user.email", "t@example.com"]);
    fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
    if (policy !== null) fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), policy);
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-m", "initial"]);
    git(root, ["clone", "--bare", seed, remoteBare]);
    const github = new FakeGitHub(remoteBare);
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
    const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
    let failNotify = false;
    const notes: string[] = [];
    const make = () =>
      new Reconciler({
        config: cfg, ledger, github, broker,
        implementer: { async run() { return { summary: "", costUsd: 0, transcriptPath: null, aborted: true }; } },
        reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
        notifier: {
          async notifyNeedsYou(i) {
            if (failNotify) throw new Error("telegram down");
            notes.push(i.title);
          },
          async sendDigest() {},
        },
      });
    return { root, seed, remoteBare, git, ledger, make, notes, setFail: (v: boolean) => (failNotify = v) };
  }

  it("retries after a failed delivery, does not repeat after a restart, and re-arms when the repo recovers", async () => {
    const w = await world(null);
    try {
      w.setFail(true);
      const a = w.make();
      await a.tick(Date.now(), { waitForAttempts: true });
      expect(w.notes).toEqual([]); // delivery failed
      w.setFail(false);
      await a.tick(Date.now(), { waitForAttempts: true });
      expect(w.notes).toHaveLength(1); // retried, not lost
      await a.tick(Date.now(), { waitForAttempts: true });
      expect(w.notes).toHaveLength(1); // once per broken commit
      const restarted = w.make(); // daemon restart: nothing in memory
      await restarted.tick(Date.now(), { waitForAttempts: true });
      expect(w.notes).toHaveLength(1);
      expect(w.ledger.listAudit({ topicPrefix: "config/repo_policy_invalid" })).toHaveLength(1);

      // Recovery clears the marker; a later break on a new commit notifies again.
      fs.writeFileSync(path.join(w.seed, ".agents", "archangel.json"), workflowJson());
      w.git(w.seed, ["add", "-A"]);
      w.git(w.seed, ["commit", "-m", "fix policy"]);
      w.git(w.seed, ["push", w.remoteBare, "main"]);
      await restarted.tick(Date.now(), { waitForAttempts: true });
      expect(w.ledger.getSystemState("policy_error_notified:acme/app")).toBeFalsy();
      fs.writeFileSync(path.join(w.seed, ".agents", "archangel.json"), "{}");
      w.git(w.seed, ["add", "-A"]);
      w.git(w.seed, ["commit", "-m", "break policy"]);
      w.git(w.seed, ["push", remoteBareOf(w), "main"]);
      await restarted.tick(Date.now(), { waitForAttempts: true });
      expect(w.notes).toHaveLength(2);
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

const remoteBareOf = (w: { remoteBare: string }) => w.remoteBare;
