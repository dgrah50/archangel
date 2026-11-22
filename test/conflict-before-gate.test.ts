import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const MIN = 60_000;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A Thread whose PR sits in awaiting_gate with no checks at all, then main moves on. */
async function harness(mainChange: "unrelated" | "same-line") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-conflict-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seed, "go.mod"), "module example.com/demo\n\ngo 1.26.0\n");
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 1 }\n");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson(["Gate", "Test"]));
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  git(root, ["clone", "--bare", seed, remoteBare]);

  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const github = new FakeGitHub(remoteBare);
  const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
  const rebaseKinds: string[] = [];
  const implementer: Implementer = {
    async run(input) {
      if (/rebase/i.test(input.prompt)) rebaseKinds.push("rebase");
      fs.writeFileSync(path.join(input.cloneDir, "app.go"), "package demo\n\nfunc Val() int { return 7 }\n");
      git(input.cloneDir, ["add", "-A"]);
      git(input.cloneDir, ["commit", "-m", "fix"]);
      return { summary: "Done.", costUsd: 0, transcriptPath: null, aborted: false };
    },
  };
  const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
  const notifier = { async notifyNeedsYou() {}, async sendDigest() {} };
  const cfg = ConfigSchema.parse({
    githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2,
    githubPrivateKeyPem: "fake", shadowMode: true,
  });
  const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });
  github.issues.set(1, {
    number: 1, title: "Issue 1", body: "b", state: "open", authorId: 999, authorLogin: "dgrah50",
    authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString(),
  });
  github.labelActors.set("1:ready-for-agent", 999);

  const t0 = Date.now();
  await reconciler.tick(t0, { waitForAttempts: true });
  expect(ledger.getThread(1)?.phase.kind).toBe("awaiting_gate");

  // main moves after the PR was opened
  if (mainChange === "unrelated") fs.writeFileSync(path.join(seed, "other.go"), "package demo\n");
  else fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 2 }\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "main moves"]);
  git(seed, ["push", remoteBare, "HEAD:main"]);

  return {
    ledger, github, reconciler, t0, rebaseKinds,
    cleanup: () => {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe("a PR that conflicts with base is rebased before the Gate timers apply", () => {
  it("clean merge-tree: deterministic rebase, no gate_timeout, clock restarted on the new head", async () => {
    const h = await harness("unrelated");
    try {
      const before = h.ledger.getThread(1)!;
      h.github.prs.get(100)!.mergeable = false;
      await h.reconciler.tick(h.t0 + 10 * MIN, { waitForAttempts: true });
      const t = h.ledger.getThread(1)!;
      expect(t.phase.kind).toBe("awaiting_gate");
      if (t.phase.kind !== "awaiting_gate" || before.phase.kind !== "awaiting_gate") throw new Error("unreachable");
      expect(t.phase.headSha).not.toBe(before.phase.headSha);
      expect(t.phase.since).toBe(h.t0 + 10 * MIN);
      expect(t.rebaseCount).toBe(1);
    } finally {
      h.cleanup();
    }
  });

});
