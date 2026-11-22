import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { Implementer } from "../src/agents/implementer.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { LocalProvider } from "../src/compute/local.js";
import { ConfigSchema } from "../src/config.js";
import { runPocBuild } from "../src/core/pitch-poc.js";
import { Ledger } from "../src/ledger/store.js";
import { okWorkflow } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const DAY = 86_400_000;

const pitchJson = JSON.stringify({
  type: "feature",
  title: "A --watch mode for the filter",
  problem: "p",
  evidence: [{ file: null, symbol: null, metric: null, research: null, note: "n" }, { file: null, symbol: null, metric: null, research: null, note: "m" }],
  proposal: "p",
  smallestVersion: "Re-run the filter when the file changes.",
  optionsConsidered: ["Do nothing", "Watch"],
  slices: [{ title: "Watch mode", acceptance: "Edits re-run the filter." }],
  measurement: "",
  figures: [], changeDiagram: null, estimates: [],
  recommendation: "do",
  size: "M",
});
const addPitch = (ledger: Ledger, n: number) =>
  ledger.recordPitch({ issueNumber: n, scoutName: "s", trustHash: "t", title: `Pitch number ${n}`, titleFp: `fp${n}`, contentSha256: "c", pitchJson });

describe("pitch proof of concept", () => {
  it("builds into a local ref and never pushes anything", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-poc-"));
    try {
      const seed = path.join(root, "seed");
      fs.mkdirSync(seed);
      git(seed, ["init", "-b", "main"]);
      git(seed, ["config", "user.name", "T"]);
      git(seed, ["config", "user.email", "t@example.com"]);
      fs.writeFileSync(path.join(seed, "app.ts"), "export const x = 1;\n");
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-m", "init"]);
      const mainSha = git(seed, ["rev-parse", "HEAD"]);
      git(root, ["clone", "--bare", seed, path.join(root, "remote.git")]);
      const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
      await broker.ensureBareRepo(path.join(root, "remote.git"));
      const pushes: string[] = [];
      broker.pushFactoryBranch = async () => void pushes.push("pushFactoryBranch");
      broker.pushDraftBranch = async () => {
        pushes.push("pushDraftBranch");
        return "";
      };
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      addPitch(ledger, 7);
      expect(ledger.reservePocBuild(7).ok).toBe(true);
      const implementer: Implementer = {
        async run(input) {
          fs.writeFileSync(path.join((await input.workspaces.local.workspace()).path, "watch.ts"), "export const watch = true;\n");
          return { summary: "done", costUsd: 0.1, transcriptPath: null, aborted: false };
        },
      };
      const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
      await runPocBuild({ ledger, broker, compute: new LocalProvider(broker), implementer, cfg, gate: okWorkflow().gate }, 7, mainSha, new AbortController());

      const poc = ledger.getPoc(7)!;
      expect(poc.state.kind).toBe("ready");
      expect(poc.diffStat).toContain("watch.ts");
      expect(git(path.join(root, "broker.git"), ["rev-parse", "refs/pitch-poc/7"])).toBe((poc.state as { headSha: string }).headSha);
      expect(pushes).toEqual([]);
      expect(git(path.join(root, "remote.git"), ["for-each-ref", "refs/pitch-poc"])).toBe("");
      expect(ledger.listAudit({ topicPrefix: "poc/" }).map((a) => a.topic).reverse()).toEqual(["poc/requested", "poc/built"]);
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("refuses and audits a third build of one pitch, and a third build in a day", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const t0 = 1_000 * DAY;
    for (const n of [1, 2]) addPitch(ledger, n);
    const finish = (n: number, at: number) => {
      ledger.stepPocState(n, { t: "build_failed", category: "aborted", at }, {}, at);
    };
    expect(ledger.reservePocBuild(1, t0).ok).toBe(true);
    finish(1, t0);
    expect(ledger.reservePocBuild(1, t0 + 1).ok).toBe(true); // the pitch's second build, the day's second
    finish(1, t0 + 1);
    expect(ledger.reservePocBuild(1, t0 + 2).ok).toBe(false); // the pitch is out of builds
    expect(ledger.reservePocBuild(2, t0 + 3).ok).toBe(false); // the day is out of builds
    expect(ledger.listAudit({ topicPrefix: "poc/refused_cap" }).map((a) => JSON.parse(a.payloadJson).scope)).toEqual(["day", "pitch"]) // newest first;
    expect(ledger.reservePocBuild(2, t0 + DAY + 10).ok).toBe(true);
    ledger.close();
  });
});
