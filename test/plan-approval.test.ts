import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import type { Notifier } from "../src/core/notifier.js";
import { PLAN_ROUNDS_PER_THREAD } from "../src/core/plan.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { workflowJson } from "./helpers/workflow.js";
import { noCli } from "./helpers/no-cli.js";

const OWNER = 999;
const PLAN = "## Approach\nAdd Val2 next to Val in app.go.\n\n## Files to change\napp.go\n\n## Tests\nNone needed.\n\n## Risks and assumptions\nNone.";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repo whose workflow asks for plan approval, one owner-labelled feature issue (#7), and an implementer that answers plan prompts with text and implement prompts with a commit. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-plan-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(seed);
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@example.com"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 1 }\n");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(seed, ".agents", "archangel.json"),
    workflowJson([], { gate: { testFileGlobs: ["**/*_test.go"], testCmd: "go test ./..." }, features: { planApproval: "owner" } }),
  );
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  git(root, ["clone", "--bare", seed, remoteBare]);

  const github = new FakeGitHub(remoteBare);
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
  const notifier: Notifier = { async notifyNeedsYou() {}, async sendDigest() {} };
  const prompts: { plan: string[]; implement: string[] } = { plan: [], implement: [] };
  const implementer: Implementer = {
    async run(input) {
      if (input.prompt.includes("Do NOT implement it")) {
        prompts.plan.push(input.prompt);
        return { summary: PLAN, costUsd: 0, transcriptPath: null, aborted: false };
      }
      prompts.implement.push(input.prompt);
      fs.writeFileSync(path.join(input.cloneDir, "app.go"), "package demo\n\nfunc Val() int { return 1 }\nfunc Val2() int { return 2 }\n");
      git(input.cloneDir, ["add", "-A"]);
      git(input.cloneDir, ["commit", "-m", "feature"]);
      return { summary: "done", costUsd: 0, transcriptPath: null, aborted: false };
    },
  };
  const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
  const cfg = ConfigSchema.parse({
    githubOwner: "acme", githubRepo: "app", ownerUserId: OWNER, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake",
  });
  const reconciler = new Reconciler({ triageInvoker: noCli, config: cfg, ledger, github, broker, implementer, reviewers, notifier });
  github.issues.set(7, {
    number: 7, title: "Add Val2", body: "Add a Val2 function", state: "open", authorId: OWNER, authorLogin: "o",
    authorAssociation: "OWNER", labels: ["ready-for-agent", "class:feature"], updatedAt: new Date().toISOString(),
  });
  github.labelActors.set("7:ready-for-agent", OWNER);
  github.labelActors.set("7:class:feature", OWNER);
  const tick = (now = Date.now()) => reconciler.tick(now, { waitForAttempts: true });
  const cleanup = () => {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  return { github, ledger, prompts, tick, cleanup };
}

describe("plan approval for features", () => {
  it("only the owner's plan:approved label advances the Thread", async () => {
    const w = world();
    try {
      await w.tick(); // plan Attempt
      expect(w.ledger.getThread(7)?.phase.kind).toBe("awaiting_plan");
      expect(w.github.comments.get(7)?.[0]).toContain("machine-written");

      w.github.issues.get(7)!.labels.push("plan:approved");
      w.github.labelActors.set("7:plan:approved", 12345); // someone else applied it
      await w.tick();
      expect(w.ledger.getThread(7)?.phase.kind).toBe("awaiting_plan");
      expect(w.prompts.implement).toHaveLength(0);

      w.github.labelActors.set("7:plan:approved", OWNER);
      await w.tick();
      expect(w.ledger.getThread(7)?.phase.kind).not.toBe("awaiting_plan");
    } finally {
      w.cleanup();
    }
  });

  it("pins the approved plan in the Ledger and gives exactly that text to the implementer", async () => {
    const w = world();
    try {
      await w.tick();
      w.github.issues.get(7)!.labels.push("plan:approved");
      w.github.labelActors.set("7:plan:approved", OWNER);
      await w.tick(); // approved
      await w.tick(); // implement
      expect(w.ledger.approvedThreadPlan(7)).toEqual({ version: 1, sha256: crypto.createHash("sha256").update(PLAN).digest("hex"), text: PLAN });
      expect(w.prompts.implement).toHaveLength(1);
      expect(w.prompts.implement[0]).toContain(PLAN);
    } finally {
      w.cleanup();
    }
  });

  it("re-plans on owner feedback a bounded number of times, then asks the owner", async () => {
    const w = world();
    try {
      let t = Date.now();
      await w.tick(t);
      for (let round = 1; round <= PLAN_ROUNDS_PER_THREAD; round++) {
        t += 10_000;
        w.github.authoredComments.set(7, [...(w.github.authoredComments.get(7) ?? []), { userId: OWNER, createdAt: t, body: `Change ${round}` }]);
        await w.tick(t + 1);
        await w.tick(t + 2);
      }
      expect(w.prompts.plan).toHaveLength(PLAN_ROUNDS_PER_THREAD);
      expect(w.prompts.plan[1]).toContain("Change 1");
      expect(w.ledger.getThread(7)?.phase).toMatchObject({ kind: "needs_you", code: "plan_unresolved" });
      expect(w.prompts.implement).toHaveLength(0);
    } finally {
      w.cleanup();
    }
  });
});
