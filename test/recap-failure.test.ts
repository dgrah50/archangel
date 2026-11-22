import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";
import { noCli } from "./helpers/no-cli.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();


describe("a failing Recap comment never rewrites a pushed Attempt", () => {
  it("keeps the Attempt succeeded and the Thread awaiting the Gate", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-recapfail-"));
    try {
      const seed = path.join(root, "seed");
      fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
      git(seed, ["init", "-q", "-b", "main"]);
      git(seed, ["config", "user.name", "T"]);
      git(seed, ["config", "user.email", "t@t"]);
      fs.writeFileSync(path.join(seed, "app.go"), "package demo\n");
      fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-qm", "i"]);
      git(root, ["clone", "-q", "--bare", seed, path.join(root, "remote.git")]);
      const github = new FakeGitHub(path.join(root, "remote.git"));
      github.upsertRecapComment = async () => {
        throw new Error("GitHub 502");
      };
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
      const rec = new Reconciler({ triageInvoker: noCli,
        config: cfg, ledger, github,
        broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
        implementer: {
          async run(input) {
            fs.writeFileSync(path.join(input.cloneDir, "app.go"), "package demo\n\nfunc V() int { return 2 }\n");
            git(input.cloneDir, ["add", "-A"]);
            git(input.cloneDir, ["commit", "-qm", "fix"]);
            return { summary: "ok", costUsd: 1.2, transcriptPath: null, aborted: false };
          },
        },
        reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
        notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
      });
      github.issues.set(4, { number: 4, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString() });
      github.labelActors.set("4:ready-for-agent", 999);
      await rec.tick(Date.now(), { waitForAttempts: true });
      expect(ledger.getAttempt(1)!.status).toBe("succeeded");
      expect(ledger.getThread(4)!.phase.kind).toBe("awaiting_gate");
      expect(ledger.getSpendBreakdown().spentUsd).toBeCloseTo(1.2); // counted once
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
