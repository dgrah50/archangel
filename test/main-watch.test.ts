import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { GitHubHttpError } from "../src/github/client.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { workflowJson } from "./helpers/workflow.js";
import { noCli } from "./helpers/no-cli.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fail = (id: number) => ({ id, name: "Test", status: "completed" as const, conclusion: "failure", appSlug: "github-actions" });

/** A repo whose main tip is a merged factory squash with a recorded post-merge watch. */
async function world(watch: object, fixForward: "off" | "race" = "off") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-mainwatch-"));
  const seed = path.join(root, "seed");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@t"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), workflowJson([], {
    landing: { bugfix: "autonomous", fixForward },
    gate: { testFileGlobs: ["**/*_test.go"], testCmd: "go test ./..." },
  }));
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "base"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Bad() {}\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "factory squash"]);
  const squash = git(seed, ["rev-parse", "HEAD"]);
  git(root, ["clone", "-q", "--bare", seed, path.join(root, "remote.git")]);
  const github = new FakeGitHub(path.join(root, "remote.git"));
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  ledger.upsertThread({ issueNumber: 5, title: "t", bodySha256: "b", branchName: "factory/5", phase: { kind: "done", outcome: "merged" } as never, now: 1 });
  const merge = ledger.recordMerge({ issueNumber: 5, prNumber: 9, headSha: "h", squashSha: squash, shadowOnly: false, mainRequired: ["Test"], now: 1 });
  ledger.updateMergeMainWatch(merge.id, watch as never);
  const notes: string[] = [];
  let down = false;
  const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
  const rec = new Reconciler({ triageInvoker: noCli,
    config: cfg, ledger, github,
    broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
    implementer: { async run() { throw new Error("unused"); } },
    reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
    notifier: {
      async notifyNeedsYou(i) {
        if (down) throw new Error("telegram down");
        notes.push(i.title);
      },
      async sendDigest() {},
    },
  });
  return { root, github, ledger, rec, squash, merge, notes, setDown: (v: boolean) => (down = v) };
}
const cleanup = (w: { root: string; ledger: Ledger }) => {
  w.ledger.close();
  fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
};
const revertPrs = (g: FakeGitHub) => [...g.prs.values()].filter((p) => p.headRef === "factory/revert-5");

describe("post-merge main watch: every failure is an explicit state", () => {
  it("does not lose the red-main alert when the notification fails: the watch stays pending and the next tick delivers it (one revert PR)", async () => {
    const w = await world({ kind: "rerun_requested", runIds: [11], at: 1 });
    try {
      w.github.checks.set(w.squash, [fail(22)]); // a new run, already failed
      w.setDown(true);
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(w.notes).toEqual([]);
      expect(w.ledger.getMerge(w.merge.id)!.mainWatch.kind).toBe("rerun_requested"); // still pending
      expect(w.ledger.getCircuitBreaker().tripped).toBe(true);
      expect(revertPrs(w.github)).toHaveLength(1);
      w.setDown(false);
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(w.notes).toHaveLength(1);
      expect(w.ledger.getMerge(w.merge.id)!.mainWatch.kind).toBe("red");
      expect(revertPrs(w.github)).toHaveLength(1); // not duplicated
    } finally {
      cleanup(w);
    }
  });

  it("tells the owner when main's CI never reported (notify first, so a failed send is retried)", async () => {
    const w = await world({ kind: "watching", since: Date.now() - 3 * 60 * 60_000 });
    try {
      w.setDown(true);
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(w.ledger.getMerge(w.merge.id)!.mainWatch.kind).toBe("watching"); // not closed silently
      w.setDown(false);
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(w.notes).toHaveLength(1);
      expect(w.notes[0]).toContain("Main unverified");
      expect(w.ledger.getMerge(w.merge.id)!.mainWatch.kind).toBe("timed_out");
    } finally {
      cleanup(w);
    }
  });

  const ciFail = { ...fail(22), output: "FAIL TestBad: got 1, want 2" };

  it("the revert opens exactly as before whether or not a fix-forward runs beside it; the knob is off by default", async () => {
    const w = await world({ kind: "rerun_requested", runIds: [11], at: 1 });
    try {
      w.github.checks.set(w.squash, [ciFail]);
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(revertPrs(w.github)).toHaveLength(1);
      expect(w.ledger.getCircuitBreaker().tripped).toBe(true);
      expect(w.github.issues.size).toBe(0);
    } finally {
      cleanup(w);
    }
  });

  it("race: one fix-forward per incident, carrying the failing output as data, and it is closed when the revert lands first", async () => {
    const w = await world({ kind: "rerun_requested", runIds: [11], at: 1 }, "race");
    try {
      w.github.checks.set(w.squash, [ciFail]);
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(revertPrs(w.github)).toHaveLength(1);
      const [issue] = [...w.github.issues.values()];
      expect(w.github.issues.size).toBe(1);
      expect(issue!.body).toContain("FAIL TestBad: got 1, want 2");
      expect(issue!.body).toContain("untrusted data");
      expect(w.ledger.claimFixForward(w.merge.id, 3)).toBe(false); // the incident has its one
      expect(w.ledger.fixForwardMergeId(issue!.number)).toBe(w.merge.id);

      const revert = revertPrs(w.github)[0]!;
      revert.state = "closed";
      revert.merged = true;
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      const thread = w.ledger.getThread(issue!.number)!;
      expect(thread.phase.kind).toBe("done");
      expect(w.github.closedIssues).toContain(issue!.number);
      expect(w.github.issues.size).toBe(1); // still just the one
    } finally {
      cleanup(w);
    }
  });

  it("a green fix-forward PR is put to the owner and the daemon never merges it, even with autonomous landing", async () => {
    const w = await world({ kind: "red", revertPrNumber: 77, escalated: false }, "race");
    try {
      git(path.join(w.root, "remote.git"), ["branch", "factory/50", w.squash]);
      w.github.prs.set(77, { number: 77, title: "revert", state: "open", merged: false, mergeCommitSha: null, draft: false, headRef: "factory/revert-5", headSha: w.squash, baseRef: "main", baseSha: w.squash, labels: [], changedFiles: [] });
      git(path.join(w.root, "remote.git"), ["branch", "factory/revert-5", w.squash]);
      const fix = await w.github.createPr({ title: "fix", body: "", head: "factory/50", base: "main" });
      const issue = await w.github.createIssue({ title: "fix-forward", body: "b", labels: [] });
      w.ledger.upsertThread({ issueNumber: issue.number, title: "fix-forward", bodySha256: (await import("node:crypto")).createHash("sha256").update("b").digest("hex"), branchName: "factory/50", phase: { kind: "landing", prNumber: fix.number, headSha: fix.headSha, baseSha: fix.baseSha }, now: 1 });
      w.ledger.appendAudit("fix_forward/started", issue.number, "factory", { mergeId: w.merge.id }, 1);
      const green = ["Gate", "Test"].map((name, i) => ({ id: 30 + i, name, status: "completed" as const, conclusion: "success", appSlug: "github-actions" }));
      w.github.checks.set(fix.headSha, green);
      w.github.checks.set(w.squash, green);
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(w.github.prs.get(fix.number)!.merged).toBe(false);
      expect(w.notes.filter((n) => n.startsWith("Fix-forward ready"))).toHaveLength(1);
    } finally {
      cleanup(w);
    }
  });
});
