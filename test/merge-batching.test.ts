import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, spyOn } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { noCli } from "./helpers/no-cli.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

it("three ready PRs land one at a time, oldest first, each rebased onto the new main and merged only on its own current head's checks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-batch-"));
  const seed = path.join(root, "seed");
  fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.name", "T"]);
  git(seed, ["config", "user.email", "t@t"]);
  fs.writeFileSync(path.join(seed, "go.mod"), "module example.com/demo\n\ngo 1.26.0\n");
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson(["Gate", "Test"]));
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", "i"]);
  git(root, ["clone", "-q", "--bare", seed, path.join(root, "remote.git")]);
  const github = new FakeGitHub(path.join(root, "remote.git"));
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  let n = 0;
  const rec = new Reconciler({
    triageInvoker: noCli,
    config: ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake", shadowMode: false, maxAutoMergesPerDay: 10 }),
    ledger,
    github,
    broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
    implementer: {
      async run(input) {
        const dir = (await input.workspaces.local.workspace()).path;
        fs.writeFileSync(path.join(dir, `f${++n}.go`), `package demo\n\nvar V${n} = ${n}\n`);
        git(dir, ["add", "-A"]);
        git(dir, ["commit", "-m", "fix"]);
        return { summary: "ok", costUsd: 0, transcriptPath: null, aborted: false };
      },
    },
    reviewers: { async reviewAll() { return { results: [{ vendor: "openai", verdict: "approve", findings: [], costUsd: 0 }, { vendor: "gemini", verdict: "approve", findings: [], costUsd: 0 }], errors: [] }; } },
    notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
  });
  try {
    for (const i of [1, 2, 3]) {
      github.issues.set(i, { number: i, title: `Bug ${i}`, body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString() });
      github.labelActors.set(`${i}:ready-for-agent`, 999);
    }
    const merges: Array<{ pr: number; sha: string; greenOnThatSha: boolean }> = [];
    const real = github.squashMergePr.bind(github);
    spyOn(github, "squashMergePr").mockImplementation(async (pr, sha, title) => {
      const green = (github.checks.get(sha) ?? []).length > 0;
      merges.push({ pr, sha, greenOnThatSha: green });
      return real(pr, sha, title);
    });
    const done = () => [1, 2, 3].every((i) => ledger.getThread(i)?.phase.kind === "done");
    for (let t = 0; t < 30 && !done(); t++) {
      // CI finishes between ticks: every head that exists now (and the main tip) goes green. A head pushed during a tick has no checks yet.
      const ok = (id: number, name: string) => ({ id, name, status: "completed" as const, conclusion: "success", appSlug: "github-actions" });
      const green = [ok(1, "Gate"), ok(2, "Test")];
      github.checks.set(await github.getBranchTipSha("main"), green);
      for (const th of ledger.listThreads()) {
        if (th.phase.kind === "awaiting_gate" || th.phase.kind === "reviewing" || th.phase.kind === "landing") github.checks.set(th.phase.headSha, green);
      }
      const before = merges.length;
      await rec.tick(Date.now(), { waitForAttempts: true });
      expect(merges.length - before).toBeLessThanOrEqual(1); // never two merges on one main tip
    }
    expect(done()).toBe(true);
    expect(merges.map((m) => m.pr)).toEqual([...merges.map((m) => m.pr)].sort((a, b) => a - b));
    expect(merges).toHaveLength(3);
    expect(merges.every((m) => m.greenOnThatSha)).toBe(true);
  } finally {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}, 60_000);
