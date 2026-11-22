import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { testFilesMentioned } from "../src/core/escalations.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const red = [
  { id: 1, name: "Gate", status: "completed" as const, conclusion: "failure", appSlug: "github-actions" },
  { id: 2, name: "Test", status: "completed" as const, conclusion: "success", appSlug: "github-actions" },
];

/** An implementer that fixes the code on its first run, then returns the same commit on the revision, saying `revisionSummary`. */
async function run(revisionSummary: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-norev-"));
  try {
    const seed = path.join(root, "seed");
    fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
    git(seed, ["init", "-q", "-b", "main"]);
    git(seed, ["config", "user.name", "T"]);
    git(seed, ["config", "user.email", "t@t"]);
    fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
    fs.writeFileSync(path.join(seed, "pitch_expiry_test.go"), "package demo\n"); // an existing test the issue contradicts
    fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-qm", "i"]);
    git(root, ["clone", "-q", "--bare", seed, path.join(root, "remote.git")]);
    const github = new FakeGitHub(path.join(root, "remote.git"));
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    let calls = 0;
    const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
    const rec = new Reconciler({
      config: cfg, ledger, github,
      broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
      implementer: {
        async run(input) {
          calls++;
          if (calls === 1) {
            fs.writeFileSync(path.join(input.cloneDir, "app.go"), "package demo\n\nfunc V() int { return 2 }\n");
            git(input.cloneDir, ["add", "-A"]);
            git(input.cloneDir, ["commit", "-qm", "fix"]);
            return { summary: "ok", costUsd: 0, transcriptPath: null, aborted: false };
          }
          return { summary: revisionSummary, costUsd: 0, transcriptPath: null, aborted: false }; // no new commit
        },
      },
      reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
      notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
    });
    github.issues.set(4, { number: 4, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString() });
    github.labelActors.set("4:ready-for-agent", 999);
    await rec.tick(Date.now(), { waitForAttempts: true }); // implement -> PR
    const head = (ledger.getThread(4)!.phase as { headSha: string }).headSha;
    github.checks.set(head, red);
    await rec.tick(Date.now(), { waitForAttempts: true }); // red Gate -> revision -> identical SHA
    const phase = ledger.getThread(4)!.phase;
    ledger.close();
    return phase;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe("a revision that changes nothing", () => {
  it("is revision_no_change, not review_vetoed, when no existing test is implicated", async () => {
    const phase = await run("I could not work out what to change.");
    expect(phase).toMatchObject({ kind: "needs_you", code: "revision_no_change" });
  });

  it("is an existing_test_conflict naming the test when the feedback points at a test file that exists on base (archangel#115)", async () => {
    const phase = await run("The issue asks for the opposite of pitch_expiry_test.go, which I left unchanged because existing tests are immutable.");
    expect(phase).toMatchObject({ kind: "needs_you", code: "existing_test_conflict" });
    expect((phase as { reason: string }).reason).toContain("pitch_expiry_test.go");
  });

});

