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
    const r = await run("{}\n");
    expect(r.thread).not.toBeNull();
    expect(r.notes.filter((n) => n.title.includes("repo policy"))).toHaveLength(0);
  });
});
