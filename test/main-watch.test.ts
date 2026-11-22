import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { GitHubHttpError } from "../src/github/client.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fail = (id: number) => ({ id, name: "Test", status: "completed" as const, conclusion: "failure", appSlug: "github-actions" });

/** A repo whose main tip is a merged factory squash with a recorded post-merge watch. */
async function world(watch: object) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-mainwatch-"));
  const seed = path.join(root, "seed");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@t"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
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
  const rec = new Reconciler({
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

  it("waits while GitHub still shows the run it was asked to rerun, then treats it as the verdict after the grace period", async () => {
    const recent = await world({ kind: "rerun_requested", runIds: [22], at: Date.now() - 60_000 });
    const old = await world({ kind: "rerun_requested", runIds: [22], at: Date.now() - 30 * 60_000 });
    try {
      for (const w of [recent, old]) w.github.checks.set(w.squash, [fail(22)]);
      await recent.rec.tick(Date.now(), { waitForAttempts: true });
      expect(recent.ledger.getCircuitBreaker().tripped).toBe(false);
      await old.rec.tick(Date.now(), { waitForAttempts: true });
      expect(old.ledger.getCircuitBreaker().tripped).toBe(true);
    } finally {
      cleanup(recent);
      cleanup(old);
    }
  });

  it("retries a transient rerun error next tick, but only a 403 means reruns are not permitted", async () => {
    const transient = await world({ kind: "watching", since: Date.now() });
    const forbidden = await world({ kind: "watching", since: Date.now() });
    try {
      for (const w of [transient, forbidden]) w.github.checks.set(w.squash, [fail(22)]);
      transient.github.rerunCheckRun = async () => {
        throw new GitHubHttpError(502, "GitHub POST failed (502): bad gateway");
      };
      forbidden.github.rerunCheckRun = async () => {
        throw new GitHubHttpError(403, "GitHub POST failed (403): forbidden");
      };
      await transient.rec.tick(Date.now(), { waitForAttempts: true });
      expect(transient.ledger.getMerge(transient.merge.id)!.mainWatch.kind).toBe("watching");
      expect(transient.ledger.getCircuitBreaker().tripped).toBe(false);
      await forbidden.rec.tick(Date.now(), { waitForAttempts: true });
      expect(forbidden.ledger.getCircuitBreaker().tripped).toBe(true);
      expect(forbidden.notes).toHaveLength(1);
    } finally {
      cleanup(transient);
      cleanup(forbidden);
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
});
