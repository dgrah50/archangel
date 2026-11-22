import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, spyOn } from "bun:test";
import { parse as parseYaml } from "yaml";
import { GitBroker } from "../src/broker/git-broker.js";
import { type LandingSnapshot } from "../src/core/blockers.js";
import { AGENT_DRAFT_PREFIX, openDraftPr, type Draft } from "../src/core/correction-draft.js";
import { Reconciler } from "../src/core/reconciler.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("Gate classify rule for agent-draft/* branches", () => {
  for (const file of ["workflows/archangel-gate.yml", ".github/workflows/archangel-gate.yml"]) {
    const wf = parseYaml(fs.readFileSync(file, "utf8")) as { jobs: { gate: { steps: Array<{ name: string; id?: string; run?: string; if?: string }> } }; permissions: Record<string, string> };
    const classify = wf.jobs.gate.steps.find((s) => s.id === "classify")!;
    const run = (env: Record<string, string>) => {
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "archangel-classify-")), "out");
      fs.writeFileSync(out, "");
      const r = spawnSync("bash", ["-c", classify.run!], { env: { PATH: process.env.PATH!, GITHUB_OUTPUT: out, ...env }, encoding: "utf8" });
      return { status: r.status, out: fs.readFileSync(out, "utf8") };
    };
    const base = { HEAD_REPO: "o/r", BASE_REPO: "o/r", AUTHOR_LOGIN: "archangel[bot]", AUTHOR_TYPE: "Bot" };

    describe(file, () => {

      it("a human on that branch name is an ordinary human PR, never a draft", () => {
        const r = run({ ...base, AUTHOR_LOGIN: "someone", AUTHOR_TYPE: "User", HEAD_REF: "agent-draft/x-1" });
        expect(r.status).toBe(0);
        expect(r.out).not.toContain("is_draft");
      });

    });
  }
});

describe("the daemon never merges a machine draft", () => {
  const snap = (over: Partial<LandingSnapshot> = {}): LandingSnapshot => ({
    prOpen: true, prDraft: false, headSha: "h", shaRecordedByBroker: true, postHandoff: false, labels: [], pauseLabel: "p", stopLabel: "s",
    circuitBreakerTripped: false, mainTipGreen: true, branchUpToDateWithMain: true, protectedFilesTouched: [], requiredChecks: [], checks: [],
    reviewsForHeadSha: [], requiredReviewers: [], mergeTreeClean: true, autoMergesToday: 0, maxAutoMergesPerDay: 3, shadowMode: false, ...over,
  });

  it("the Lander leaves an all-green, fully approved agent-draft/* PR unmerged, with the same setup that merges a factory PR", async () => {
    const run = async (rename: boolean) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-nodraftmerge-"));
      const seed = path.join(root, "seed");
      fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
      git(seed, ["init", "-q", "-b", "main"]);
      git(seed, ["config", "user.name", "T"]);
      git(seed, ["config", "user.email", "t@t"]);
      fs.writeFileSync(path.join(seed, "go.mod"), "module example.com/demo\n\ngo 1.26.0\n");
      fs.writeFileSync(path.join(seed, "app.go"), "package demo\n\nfunc Val() int { return 1 }\n");
      fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson(["Gate", "Test (ubuntu-latest)", "Test (macos-latest)"]));
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-qm", "i"]);
      git(root, ["clone", "-q", "--bare", seed, path.join(root, "remote.git")]);
      const github = new FakeGitHub(path.join(root, "remote.git"));
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      const { ConfigSchema } = await import("../src/config.js");
      const rec = new Reconciler({
        config: ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake", shadowMode: false }),
        ledger, github,
        broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
        implementer: { async run(input) { fs.writeFileSync(path.join(input.cloneDir, "app.go"), "package demo\n\nfunc Val() int { return 99 }\n"); git(input.cloneDir, ["add", "-A"]); git(input.cloneDir, ["commit", "-m", "fix"]); return { summary: "ok", costUsd: 0, transcriptPath: null, aborted: false }; } },
        reviewers: { async reviewAll() { return { results: [{ vendor: "openai", verdict: "approve", findings: [], costUsd: 0 }, { vendor: "gemini", verdict: "approve", findings: [], costUsd: 0 }], errors: [] }; } },
        notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
      });
      try {
        github.issues.set(5, { number: 5, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: new Date().toISOString() });
        github.labelActors.set("5:ready-for-agent", 999);
        await rec.tick(Date.now(), { waitForAttempts: true });
        const p = ledger.getThread(5)!.phase;
        const headSha = p.kind === "awaiting_gate" ? p.headSha : "";
        const green = [
          { id: 1, name: "Gate", status: "completed" as const, conclusion: "success", appSlug: "github-actions" },
          { id: 2, name: "Test (ubuntu-latest)", status: "completed" as const, conclusion: "success", appSlug: "github-actions" },
          { id: 3, name: "Test (macos-latest)", status: "completed" as const, conclusion: "success", appSlug: "github-actions" },
        ];
        github.checks.set(await github.getBranchTipSha("main"), green);
        github.checks.set(headSha, green);
        if (rename) {
          const live = github.getPrLive.bind(github);
          spyOn(github, "getPrLive").mockImplementation(async (n: number) => ({ ...(await live(n)), headRef: `${AGENT_DRAFT_PREFIX}x-1` }));
        }
        const merge = spyOn(github, "squashMergePr");
        await rec.tick(Date.now(), { waitForAttempts: true });
        await rec.tick(Date.now(), { waitForAttempts: true });
        return { merged: merge.mock.calls.length, phase: ledger.getThread(5)!.phase.kind };
      } finally {
        ledger.close();
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    };
    expect(await run(false)).toEqual({ merged: 1, phase: "done" }); // control: the same setup does merge a factory PR
    expect(await run(true)).toEqual({ merged: 0, phase: "landing" });
  });
});

describe("opening a draft PR as the App", () => {
  const draft: Draft = { target: "skill", file: "skills/general/gate-first.md", diff: ["diff --git a/skills/general/gate-first.md b/skills/general/gate-first.md", "new file mode 100644", "--- /dev/null", "+++ b/skills/general/gate-first.md", "@@ -0,0 +1 @@", "+# Gate first", ""].join("\n"), rationale: "r" };

  it("pushes one commit on an agent-draft branch with the broker, opens the PR through the App client and labels it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-draftpush-"));
    try {
      const seed = path.join(root, "seed");
      fs.mkdirSync(seed);
      git(seed, ["init", "-q", "-b", "main"]);
      git(seed, ["config", "user.name", "T"]);
      git(seed, ["config", "user.email", "t@t"]);
      fs.writeFileSync(path.join(seed, "README.md"), "hi\n");
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-qm", "i"]);
      const remote = path.join(root, "remote.git");
      git(root, ["clone", "-q", "--bare", seed, remote]);
      const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
      await broker.ensureBareRepo(remote);
      await broker.syncFromRemote(remote);
      const tip = git(remote, ["rev-parse", "main"]);
      const calls: string[] = [];
      const github = {
        getRemoteUrlWithToken: async () => remote,
        getBranchTipSha: async () => tip,
        createPr: async (i: { head: string; base: string; title: string; body: string }) => { calls.push(`pr:${i.head}:${i.base}:${i.body}`); return { number: 77 }; },
        addLabels: async (n: number, l: string[]) => { calls.push(`label:${n}:${l.join(",")}`); },
      };
      const url = await openDraftPr({ github, broker }, draft, "BODY", { category: "owner_retry:gate_failed", count: 3, windowDays: 30, seq: 2 });
      expect(url).toBe("https://github.com/dgrah50/archangel/pull/77");
      expect(calls).toEqual(["pr:agent-draft/owner-retry-gate-failed-2:main:BODY", "label:77:agent-proposed"]);
      const branchSha = git(remote, ["rev-parse", "agent-draft/owner-retry-gate-failed-2"]);
      expect(git(remote, ["rev-parse", `${branchSha}^`])).toBe(tip); // one commit on top of main
      expect(git(remote, ["show", `${branchSha}:skills/general/gate-first.md`])).toBe("# Gate first");
      expect(git(remote, ["show", `${branchSha}:README.md`])).toBe("hi"); // the rest of the tree is untouched
      await expect(broker.pushDraftBranch("factory/5", tip, "a.md", "x", "m", remote)).rejects.toThrow(/non-draft/);
      await expect(broker.pushDraftBranch("agent-draft/..-1", tip, "a.md", "x", "m", remote)).rejects.toThrow(/non-draft/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
