import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, spyOn } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-issueread-"));
  const seed = path.join(root, "seed");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@t"]);
  fs.writeFileSync(path.join(seed, "a.txt"), "x");
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "i"]);
  git(root, ["clone", "-q", "--bare", seed, path.join(root, "remote.git")]);
  const github = new FakeGitHub(path.join(root, "remote.git"));
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
  const warnings: string[] = [];
  const rec = new Reconciler({
    config: cfg, ledger, github,
    broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
    implementer: { async run() { throw new Error("unused"); } },
    reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
    notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
    logger: { info() {}, warn: (e: string, m: string) => void warnings.push(`${e}: ${m}`), error() {} } as never,
  });
  // an in-progress Thread (awaiting the Gate on an open PR)
  github.issues.set(4, { number: 4, title: "t", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["factory:stop"], updatedAt: "" });
  ledger.upsertThread({
    issueNumber: 4, title: "t", bodySha256: "x", now: 1,
    phase: { kind: "awaiting_gate", prNumber: 9, headSha: "h", baseSha: "b", since: 1, nudgedAt: null } as never,
  });
  return { root, github, ledger, rec, warnings };
}

describe("an unreadable issue never lets a Thread advance", () => {
  it("skips the Thread this tick, logs it, and retries once the read works (the owner's factory:stop is never missed)", async () => {
    const w = await world();
    try {
      const reconcileThread = spyOn(w.rec as unknown as { reconcileThread: (...a: unknown[]) => Promise<void> }, "reconcileThread").mockResolvedValue();
      const real = w.github.getIssue.bind(w.github);
      w.github.getIssue = async () => {
        throw new Error("GitHub 502");
      };
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(reconcileThread).not.toHaveBeenCalled();
      expect(w.warnings.join("\n")).toContain("thread/github_read_failed");
      w.github.getIssue = real;
      await w.rec.tick(Date.now(), { waitForAttempts: true });
      expect(reconcileThread).toHaveBeenCalledTimes(1);
      expect((reconcileThread.mock.calls[0] as unknown[])[1]).toMatchObject({ number: 4, labels: ["factory:stop"] });
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
