import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-race-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@example.com"]);
  fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  git(root, ["clone", "--bare", seed, remoteBare]);
  return { root, seed, remoteBare };
}

describe("GitBroker.readFileAtRef", () => {
  it("returns null only for a path that is absent, and throws for a commit the repo does not have", async () => {
    const { root, remoteBare } = setup();
    try {
      const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
      await broker.ensureBareRepo(remoteBare);
      const tip = git(remoteBare, ["rev-parse", "main"]);
      expect(await broker.readFileAtRef(tip, "app.go")).toBe("package demo\n");
      expect(await broker.readFileAtRef(tip, "nope.txt")).toBeNull();
      await expect(broker.readFileAtRef("f".repeat(40), "app.go")).rejects.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("a main commit that lands between the fetch and the tip lookup", () => {
  it("is fetched before the workflow is read: no false 'missing' halt and no Needs You", async () => {
    const { root, seed, remoteBare } = setup();
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
    const notes: string[] = [];
    try {
      const github = new FakeGitHub(remoteBare);
      // GitHub reports a tip that the broker's fetch (which ran just before) did not yet see.
      let landed = false;
      github.getBranchTipSha = async (branch: string) => {
        if (!landed) {
          landed = true;
          fs.writeFileSync(path.join(seed, "later.txt"), "x\n");
          git(seed, ["add", "-A"]);
          git(seed, ["commit", "-m", "lands mid-tick"]);
          git(seed, ["push", remoteBare, "main"]);
        }
        return git(remoteBare, ["rev-parse", `refs/heads/${branch}`]);
      };
      const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
      const rec = new Reconciler({
        config: cfg, ledger, github, broker,
        implementer: { async run() { return { summary: "", costUsd: 0, transcriptPath: null, aborted: true }; } },
        reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
        notifier: { async notifyNeedsYou(i) { notes.push(i.title); }, async sendDigest() {} },
      });
      await broker.ensureBareRepo(remoteBare); // an earlier tick already cloned: the next fetch happens inside tick()
      await rec.tick(Date.now(), { waitForAttempts: true });
      expect(notes).toEqual([]);
      const cached = ledger.listCachedWorkflows().find((c) => c.repo === "acme/app")!.workflow as { status: string };
      expect(cached.status).toBe("ok");
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
