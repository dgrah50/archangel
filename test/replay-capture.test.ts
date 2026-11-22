import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { promptTemplateSha, rubricSha } from "../src/agents/prompts.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import type { Notifier } from "../src/core/notifier.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const refs = (bare: string, prefix: string) => git(bare, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]).split("\n").filter(Boolean);
const cfg = () =>
  ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
const notifier: Notifier = { async notifyNeedsYou() {}, async sendDigest() {} };
const green = (id: number, name: string) => ({ id, name, status: "completed" as const, conclusion: "success", appSlug: "github-actions" });

function seedRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-replay-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(seed);
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@example.com"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 1 }\n");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  const mainSha = git(seed, ["rev-parse", "HEAD"]);
  git(root, ["clone", "--bare", seed, remoteBare]);
  return { root, remoteBare, mainSha };
}

describe("provenance and eval refs are captured as work happens", () => {
  it("records who ran each Attempt and review, with prompt, rubric and workflow hashes, and pins base and head", async () => {
    const { root, remoteBare, mainSha } = seedRepo();
    const github = new FakeGitHub(remoteBare);
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const bare = path.join(root, "broker.git");
    const broker = new GitBroker({ bareRepoPath: bare, clonesDir: path.join(root, "clones") });
    const implementer: Implementer = {
      async run(input) {
        fs.writeFileSync(path.join(input.cloneDir, "app.go"), "package demo\n\nfunc Val() int { return 12 }\n");
        git(input.cloneDir, ["add", "-A"]);
        git(input.cloneDir, ["commit", "-m", "fix"]);
        return { summary: "ok", costUsd: 0, transcriptPath: null, aborted: false, runBy: { provider: "codex", model: "m-impl" } };
      },
    };
    const reviewers: ReviewerSuite = {
      async reviewAll(req) {
        return {
          results: (["anthropic", "gemini"] as const)
            .filter((v) => !(req.skipVendors ?? []).includes(v))
            .map((vendor, i) => ({
              vendor, verdict: "approve" as const, findings: [], costUsd: 0,
              provider: vendor === "gemini" ? "agy" : "claude", model: `m-rev-${i}`, promptSha256: promptTemplateSha(i === 0 ? "review_contract" : "review_adversarial"),
            })),
          errors: [],
        };
      },
    };
    const reconciler = new Reconciler({ config: cfg(), ledger, github, broker, implementer, reviewers, notifier });
    try {
      github.issues.set(4, {
        number: 4, title: "Bug 4", body: "Val should be 12", state: "open", authorId: 999, authorLogin: "o",
        authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString(),
      });
      github.labelActors.set("4:ready-for-agent", 999);
      await reconciler.tick(Date.now(), { waitForAttempts: true });
      const head = (ledger.getThread(4)!.phase as { headSha: string }).headSha;
      github.checks.set(head, [green(1, "Gate"), green(2, "Test")]);
      github.checks.set(mainSha, [green(3, "Gate"), green(4, "Test")]);
      for (let i = 0; i < 4 && ledger.getReviewsForSha(4, head).length < 2; i++) await reconciler.tick(Date.now(), { waitForAttempts: true });

      const attempt = ledger.getAttempt(1)!;
      expect(attempt).toMatchObject({ provider: "codex", model: "m-impl", promptSha256: promptTemplateSha("implement") });
      expect(attempt.workflowSha256).toMatch(/^[0-9a-f]{64}$/);

      const reviews = ledger.getReviewsForSha(4, head);
      expect(reviews).toHaveLength(2);
      for (const r of reviews) {
        expect(r.provider).toBeTruthy();
        expect(r.model).toMatch(/^m-rev-/);
        expect(r.promptSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(r.rubricSha256).toBe(rubricSha(undefined));
        expect(r.workflowSha256).toBe(attempt.workflowSha256);
      }
      const pinned = refs(bare, "refs/archangel/eval/acme/app/4/").map((l) => l.split(" ")[1]);
      expect(pinned).toContain(mainSha); // base
      expect(pinned).toContain(head); // reviewed head
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

});

describe("eval refs", () => {
  it("survive the remote deleting the branch and the broker pruning and collecting garbage; re-pinning is idempotent", async () => {
    const { root, remoteBare } = seedRepo();
    const bare = path.join(root, "broker.git");
    const broker = new GitBroker({ bareRepoPath: bare, clonesDir: path.join(root, "clones") });
    try {
      // A factory branch on the remote with a commit that exists nowhere else.
      const work = path.join(root, "work");
      git(root, ["clone", remoteBare, work]);
      git(work, ["config", "user.name", "T"]);
      git(work, ["config", "user.email", "t@example.com"]);
      git(work, ["checkout", "-b", "factory/5"]);
      fs.writeFileSync(path.join(work, "x.txt"), "reviewed\n");
      git(work, ["add", "-A"]);
      git(work, ["commit", "-m", "reviewed head"]);
      const reviewed = git(work, ["rev-parse", "HEAD"]);
      git(work, ["push", "origin", "factory/5"]);

      await broker.ensureBareRepo(remoteBare);
      await broker.syncFromRemote(remoteBare);
      const ref = await broker.pinEvalRef("acme/app", 5, reviewed);
      expect(ref).toBe("refs/archangel/eval/acme/app/5/1");
      expect(await broker.pinEvalRef("acme/app", 5, reviewed)).toBe(ref); // idempotent
      expect(refs(bare, "refs/archangel/eval/acme/app/5/")).toHaveLength(1);

      // GitHub deletes the merged branch; the broker prunes and collects garbage.
      git(remoteBare, ["branch", "-D", "factory/5"]);
      await broker.syncFromRemote(remoteBare);
      expect(refs(bare, "refs/heads/factory/")).toEqual([]);
      git(bare, ["reflog", "expire", "--expire=now", "--all"]);
      git(bare, ["gc", "--prune=now", "--quiet"]);
      expect(git(bare, ["cat-file", "-t", reviewed])).toBe("commit");
      expect(git(bare, ["rev-parse", ref!])).toBe(reviewed);

      // A second sha for the same Thread gets the next ordinal; an unknown or malformed sha pins nothing / throws.
      const main = git(bare, ["rev-parse", "refs/heads/main"]);
      expect(await broker.pinEvalRef("acme/app", 5, main)).toBe("refs/archangel/eval/acme/app/5/2");
      expect(await broker.pinEvalRef("acme/app", 5, "f".repeat(40))).toBeNull();
      await expect(broker.pinEvalRef("acme/app", 5, "nope")).rejects.toThrow(/bad repo or sha/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

});
