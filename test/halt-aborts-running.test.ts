import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { Implementer } from "../src/agents/implementer.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";
import { noCli } from "./helpers/no-cli.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("a halted repo stops its in-flight work", () => {
  it("aborts a running Attempt when the workflow becomes invalid, returns the Thread to the queue, and starts nothing else", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-halt-"));
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

    const github = new FakeGitHub(remoteBare);
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
    let runs = 0;
    let sawAbort = false;
    const implementer: Implementer = {
      async run(input) {
        runs++;
        // Works until aborted; gives up by itself after 4s so a missing abort fails the test instead of hanging it.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 4000);
          input.abortController.signal.addEventListener("abort", () => {
            sawAbort = true;
            clearTimeout(t);
            resolve();
          });
        });
        return { summary: "", costUsd: 0, transcriptPath: null, aborted: input.abortController.signal.aborted };
      },
    };
    const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
    const rec = new Reconciler({ triageInvoker: noCli,
      config: cfg, ledger, github, broker, implementer,
      reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
      notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
    });
    try {
      github.issues.set(4, {
        number: 4, title: "Bug 4", body: "b", state: "open", authorId: 999, authorLogin: "o",
        authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString(),
      });
      github.labelActors.set("4:ready-for-agent", 999);
      await rec.tick(Date.now(), { waitForAttempts: false });
      await new Promise((r) => setTimeout(r, 300));
      expect(rec.activeTaskCount()).toBe(1);
      expect(ledger.getThread(4)!.phase.kind).toBe("working");

      // main now carries a broken workflow file
      fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), "{}");
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-m", "break the workflow"]);
      git(seed, ["push", remoteBare, "main"]);

      await rec.tick(Date.now(), { waitForAttempts: true });
      expect(sawAbort).toBe(true);
      expect(rec.activeTaskCount()).toBe(0);
      expect(ledger.getThread(4)!.phase.kind).toBe("queued");
      expect(runs).toBe(1); // no new Attempt while halted
      await rec.tick(Date.now(), { waitForAttempts: true });
      expect(runs).toBe(1);
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

});
