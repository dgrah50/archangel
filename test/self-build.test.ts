import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import type { Implementer } from "../src/agents/implementer.js";
import type { OnboardRunner } from "../src/core/onboard.js";
import { scoutContentHash } from "../src/core/scout.js";
import { selfBuild } from "../src/core/self-build.js";
import { Ledger } from "../src/ledger/store.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const pitchJson = JSON.stringify({
  type: "feature", title: "Tighten the gate", problem: "p",
  evidence: [{ file: null, symbol: null, metric: null, research: null, watched: null, note: "n" }, { file: null, symbol: null, metric: null, research: null, watched: null, note: "m" }],
  proposal: "p", smallestVersion: "s", optionsConsidered: ["Do nothing", "Tighten"],
  slices: [{ title: "Tighten", acceptance: "Done." }], measurement: "", figures: [], changeDiagram: null, estimates: [], recommendation: "do", size: "M",
});

describe("archangel pitch promote --build", () => {
  it("pushes a selfbuild branch (never factory/*) touching a protected path, opens a PR, and never merges", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-selfbuild-test-"));
    try {
      const seed = path.join(root, "seed");
      fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
      git(seed, ["init", "-b", "main"]);
      git(seed, ["config", "user.name", "T"]);
      git(seed, ["config", "user.email", "t@example.com"]);
      fs.writeFileSync(path.join(seed, ".agents/archangel.json"), JSON.stringify({ version: 1, gate: { testCmd: "true", protectedPaths: ["src/gate/**"] } }));
      fs.mkdirSync(path.join(seed, "src/gate"), { recursive: true });
      fs.writeFileSync(path.join(seed, "src/gate/g.ts"), "export const g = 1;\n");
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-m", "init"]);
      git(root, ["clone", "--bare", seed, path.join(root, "remote.git")]);

      const title = "Tighten the gate";
      const body = "body";
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      ledger.recordPitch({ issueNumber: 7, scoutName: "s", trustHash: "t", title, titleFp: "fp", contentSha256: scoutContentHash(title, body), pitchJson });

      const ghCalls: string[][] = [];
      const runner: OnboardRunner = {
        async run(cmd, args, opts) {
          if (cmd === "gh") {
            ghCalls.push(args);
            if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ title, body, state: "OPEN", labels: [{ name: "agent-pitch" }] });
            if (args[0] === "repo") return execFileSync("git", ["clone", "--bare", path.join(root, "remote.git"), args[3]!], { encoding: "utf8" });
            if (args[0] === "pr") return "https://github.com/acme/app/pull/9\n";
            return "";
          }
          return execFileSync("git", args, { cwd: opts?.cwd, encoding: "utf8" });
        },
      };
      const implementer: Implementer = {
        async run(input) {
          const ws = await input.workspaces.local.workspace();
          fs.writeFileSync(path.join(ws.path, "src/gate/g.ts"), "export const g = 2;\n");
          return { summary: "done", costUsd: 0, transcriptPath: null, aborted: false };
        },
      };

      const url = await selfBuild(runner, ledger, {
        repo: "acme/app", issue: 7, slice: "1", yes: true, labels: { agentPitch: "agent-pitch" },
        cfg: { implementTimeoutMs: 60_000, setupTimeoutMs: 60_000 },
        implementer, confirm: async () => false, log: () => {},
      });

      expect(url).toBe("https://github.com/acme/app/pull/9");
      const branches = git(path.join(root, "remote.git"), ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n");
      expect(branches.sort()).toEqual(["main", "selfbuild/7-1"]);
      expect(git(path.join(root, "remote.git"), ["show", "selfbuild/7-1:src/gate/g.ts"])).toContain("= 2");
      expect(ghCalls.some((a) => a[0] === "pr" && a[1] === "merge")).toBe(false);
      expect(ghCalls.some((a) => a[0] === "pr" && a[1] === "create")).toBe(true);
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("is reachable only from the owner's CLI, never from the daemon", () => {
    const importers = execFileSync("grep", ["-rl", "self-build.js", "src"], { encoding: "utf8" }).trim().split("\n");
    expect(importers).toEqual(["src/cli/index.ts"]);
  });
});
