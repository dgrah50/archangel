import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { AttemptError } from "../src/ledger/schema.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";
import { noCli } from "./helpers/no-cli.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

type Implementer = ConstructorParameters<typeof Reconciler>[0]["implementer"];

describe("an implementer that did not finish is a failed Attempt", () => {
  async function failedAttempt(implementer: Implementer, check: (ctx: { ledger: Ledger; github: FakeGitHub; notified: Array<{ decisionClass: string; recommendation: string }> }) => void) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-implfail-"));
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
      const notified: Array<{ decisionClass: string; recommendation: string }> = [];
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
      const rec = new Reconciler({ triageInvoker: noCli,
        config: cfg, ledger, github,
        broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
        implementer,
        reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
        notifier: { async notifyNeedsYou(n) { notified.push(n); }, async sendDigest() {} },
      });
      github.issues.set(4, { number: 4, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString() });
      github.labelActors.set("4:ready-for-agent", 999);
      await rec.tick(Date.now(), { waitForAttempts: true });
      await rec.tick(Date.now(), { waitForAttempts: true });
      check({ ledger, github, notified });
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  it("records the cause and the cost and escalates, instead of validating whatever it left behind", async () => {
    await failedAttempt(
      {
          async run(input) {
            fs.writeFileSync(path.join((await input.workspaces.local.workspace()).path, "app.go"), "package demo\n\nfunc V() int { return 2 }\n");
            git((await input.workspaces.local.workspace()).path, ["add", "-A"]);
            git((await input.workspaces.local.workspace()).path, ["commit", "-qm", "half a fix"]);
            return { summary: "", costUsd: 0.7, transcriptPath: null, aborted: false, failure: "error_max_turns" };
          },
        },
      ({ ledger, github }) => {
        const a = ledger.getAttempt(1)!;
        expect(a.status).toBe("failed");
        expect(a.errorMessage).toContain("error_max_turns");
        expect(ledger.getSpendBreakdown().spentUsd).toBeCloseTo(0.7);
        expect(ledger.getThread(4)!.phase).toMatchObject({ kind: "needs_you", code: "attempt_failed" });
        expect(github.prs.size).toBe(0); // nothing was pushed or opened
      },
    );
  });

  it("puts an expired login to the owner as credentials, with the login advice", async () => {
    await failedAttempt(
      { async run() { throw new AttemptError("auth", "claude: login expired"); } },
      ({ ledger, notified }) => {
        expect(ledger.getThread(4)!.phase).toMatchObject({ kind: "needs_you", code: "attempt_failed", cause: "auth" });
        expect(notified[0]).toMatchObject({ decisionClass: "credentials" });
        expect(notified[0]!.recommendation).toContain("re-login");
      },
    );
  });
});
