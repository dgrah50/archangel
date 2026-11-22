import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import type { Notifier } from "../src/core/notifier.js";
import { Reconciler } from "../src/core/reconciler.js";
import { stepPhase } from "../src/core/thread-machine.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-slicedep-"));
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
  git(root, ["clone", "--bare", seed, remoteBare]);
  const github = new FakeGitHub(remoteBare);
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
  const notes: Array<{ issueNumber: number | null; decisionClass: string }> = [];
  const notifier: Notifier = { async notifyNeedsYou(i) { notes.push(i); }, async sendDigest() {} };
  const ran: number[] = [];
  const implementer: Implementer = {
    async run(input) {
      ran.push(input.issueNumber);
      fs.writeFileSync(path.join(input.cloneDir, "app.go"), `package demo\n\nfunc Val() int { return ${10 + ran.length} }\n`);
      git(input.cloneDir, ["add", "-A"]);
      git(input.cloneDir, ["commit", "-m", `attempt ${ran.length}`]);
      return { summary: "ok", costUsd: 0, transcriptPath: null, aborted: false };
    },
  };
  const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
  const cfg = ConfigSchema.parse({
    githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake",
  });
  const reconciler = new Reconciler({ config: cfg, ledger, github, broker, implementer, reviewers, notifier });
  for (const n of [10, 11]) {
    github.issues.set(n, { number: n, title: `Slice ${n}`, body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent", "class:feature"], updatedAt: "" });
    github.labelActors.set(`${n}:ready-for-agent`, 999);
    github.labelActors.set(`${n}:class:feature`, 999);
  }
  ledger.addThreadDependency(11, 10); // 11 waits for 10
  const tick = (i: number) => reconciler.tick(Date.now() + i * 1000, { waitForAttempts: true });
  const finish = (n: number, outcome: "merged" | "owner_merged" | "pr_closed" | "abandoned") => {
    const t = ledger.getThread(n)!;
    const ev =
      outcome === "abandoned"
        ? ({ t: "owner_abandon" } as const)
        : ({ t: "pr_observed", status: outcome === "pr_closed" ? "closed" : "merged" } as const);
    const stepped = stepPhase(t.phase, t.mode, ev, { issueNumber: n, title: t.title, needsYouLabel: "needs-you" });
    if (!stepped.ok) throw new Error(stepped.reject);
    ledger.transition(n, t.version, stepped.next);
  };
  return { ledger, ran, notes, tick, finish, github, cleanup: () => { ledger.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

describe("chained slice dependencies", () => {
  it("holds the dependent slice queued until its predecessor's Thread is merged, then starts it", async () => {
    const s = setup();
    try {
      await s.tick(0);
      await s.tick(1);
      expect(s.ran).toEqual([10]); // only the first slice runs
      expect(s.ledger.getThread(11)?.phase.kind).toBe("queued");
      // Predecessor still in flight (not merged): the dependent stays held across ticks.
      await s.tick(2);
      expect(s.ran).toEqual([10]);
      s.finish(10, "owner_merged");
      await s.tick(3);
      expect(s.ran).toEqual([10, 11]);
      expect(s.ledger.getThreadDependency(11)).toBeNull();
      expect(s.notes).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  it("raises exactly one owner_signoff Needs You when the predecessor ended unmerged, and a retry then runs the slice on its own", async () => {
    const s = setup();
    try {
      await s.tick(0);
      s.finish(10, "abandoned");
      await s.tick(1);
      await s.tick(2);
      await s.tick(3);
      expect(s.ran).toEqual([10]); // the dependent never started
      expect(s.ledger.getThread(11)?.phase).toMatchObject({ kind: "needs_you", code: "dependency_unmet" });
      expect(s.notes.filter((n) => n.issueNumber === 11)).toHaveLength(1);
      expect(s.notes.find((n) => n.issueNumber === 11)!.decisionClass).toBe("owner signoff");
      expect(s.ledger.getThreadDependency(11)).toBeNull(); // consumed: no repeat escalation

      // The owner removes needs-you: the slice now runs without the dependency.
      s.github.issues.get(11)!.labels = ["ready-for-agent", "class:feature"];
      await s.tick(4);
      expect(s.ran).toContain(11);
    } finally {
      s.cleanup();
    }
  });

});