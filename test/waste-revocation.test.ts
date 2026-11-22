import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Implementer } from "../src/agents/implementer.js";
import type { ReviewerSuite } from "../src/agents/reviewers.js";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import type { DoneOutcome } from "../src/core/thread-machine.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { SCOUT_PROMPT, hashOfScout, workflowJson } from "./helpers/workflow.js";

const AUTO_SCOUT = { name: "auto-hunt", schedule: "daily", maxProposals: 2, promotion: "auto" };
const HASH = hashOfScout(AUTO_SCOUT);

type End = DoneOutcome | "needs_you" | "in_flight";
let clock = 1000;

/** One auto-promoted proposal (oldest first via `clock`) whose Thread ended as `end`. */
function promote(ledger: Ledger, issue: number, end: End, hash = HASH) {
  const now = clock++;
  const phase =
    end === "needs_you"
      ? ({ kind: "needs_you", code: "review_vetoed", reason: "x", resumeTo: { kind: "queued" } } as const)
      : end === "in_flight"
        ? ({ kind: "queued" } as const)
        : ({ kind: "done", outcome: end } as const);
  ledger.upsertThread({ issueNumber: issue, title: `i${issue}`, bodySha256: `s${issue}`, phase, now });
  ledger.recordScoutProposal({ issueNumber: issue, scoutName: "auto-hunt", contentSha256: `c${issue}`, titleFp: `f${issue}`, fileSha256: hash, autoPromoted: true, now });
}

describe("waste revocation of auto-promotion", () => {
  it("revokes after 3 auto-promoted Threads in a row end without a merge (Needs You, PR closed, abandoned)", () => {
    const l = new Ledger(":memory:", { repo: "acme/app" });
    promote(l, 1, "pr_closed");
    promote(l, 2, "abandoned");
    expect(l.isScoutAutoPromoteRevoked("auto-hunt", HASH)).toBe(false);
    promote(l, 3, "needs_you");
    expect(l.isScoutAutoPromoteWasted("auto-hunt", HASH)).toBe(true);
    expect(l.isScoutAutoPromoteRevoked("auto-hunt", HASH)).toBe(true);
    l.close();
  });

});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("waste revocation notification", () => {
  it("raises exactly one owner_signoff Needs You, however many ticks follow", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-waste-"));
    try {
      const seed = path.join(root, "seed");
      const remoteBare = path.join(root, "remote.git");
      fs.mkdirSync(path.join(seed, ".agents", "scouts"), { recursive: true });
      git(seed, ["init", "-b", "main"]);
      git(seed, ["config", "user.name", "Test"]);
      git(seed, ["config", "user.email", "test@example.com"]);
      fs.writeFileSync(path.join(seed, "app.ts"), "export const x = 1;\n");
      fs.writeFileSync(path.join(seed, ".agents", "scouts", "auto-hunt.md"), `${SCOUT_PROMPT}\n`);
      fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), workflowJson([AUTO_SCOUT]));
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-m", "initial"]);
      git(root, ["clone", "--bare", seed, remoteBare]);

      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      for (const n of [1, 2, 3]) promote(ledger, n, "pr_closed");
      const notes: Array<{ issueNumber: number | null; decisionClass: string; recommendation: string; title: string }> = [];
      const notifier = { async notifyNeedsYou(i: (typeof notes)[number]) { notes.push(i); }, async sendDigest() {} };
      const cfg = ConfigSchema.parse({
        githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake",
      });
      const implementer: Implementer = { async run() { throw new Error("unused"); } };
      const reviewers: ReviewerSuite = { async reviewAll() { return { results: [], errors: [] }; } };
      const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
      const rec = new Reconciler({ config: cfg, ledger, github: new FakeGitHub(remoteBare), broker, implementer, reviewers, notifier });

      await rec.tick(Date.now());
      await rec.tick(Date.now() + 30_000);
      await rec.tick(Date.now() + 60_000);

      expect(notes).toHaveLength(1);
      expect(notes[0]!.issueNumber).toBeNull();
      expect(notes[0]!.decisionClass).toBe("owner signoff");
      expect(notes[0]!.title).toContain("auto-hunt");
      expect(notes[0]!.recommendation).toContain("Review its recent proposals");
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

});
