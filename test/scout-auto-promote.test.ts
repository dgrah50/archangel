import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema, type ArchangelConfig } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { normalizeTitleFp, runScoutsForProject, scoutContentHash } from "../src/core/scout.js";
import type { GitHubClient, GitHubIssue } from "../src/github/client.js";
import { Ledger } from "../src/ledger/store.js";

const AUTO_SCOUT = `---\nname: auto-hunt\nschedule: daily\nmaxProposals: 2\nautoPromote: true\n---\nFind real bugs in app.ts.\n`;
const MANUAL_SCOUT = `---\nname: auto-hunt\nschedule: daily\nmaxProposals: 2\n---\nFind real bugs in app.ts.\n`;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture(scout: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-autopromote-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(path.join(seed, ".agents", "scouts"), { recursive: true });
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seed, "app.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(seed, ".agents", "scouts", "auto-hunt.md"), scout);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  const mainSha = git(seed, ["rev-parse", "HEAD"]);
  git(root, ["clone", "--bare", seed, remoteBare]);
  const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
  await broker.ensureBareRepo(remoteBare);
  return { root, remoteBare, mainSha, broker };
}

function makeConfig(overrides: Partial<ArchangelConfig> = {}): ArchangelConfig {
  return ConfigSchema.parse({
    githubOwner: "acme",
    githubRepo: "app",
    ownerUserId: 999,
    githubAppId: "123",
    githubInstallationId: 456,
    githubPrivateKeyPem: "fake",
    githubAppBotUserId: 777,
    authMode: "subscription",
    scouts: { enabled: true, maxRunsPerDay: 5, maxOpenProposals: 5, maxAutoPromotionsPerDay: 1 },
    ...overrides,
  });
}

function fakeScoutGitHub() {
  const labelsAdded: Array<{ n: number; labels: string[] }> = [];
  let next = 60;
  const gh = {
    listOpenIssuesByLabel: async () => [],
    addLabels: async (n: number, labels: string[]) => {
      labelsAdded.push({ n, labels });
    },
    createIssue: async (input: { title: string; body: string; labels: string[] }) =>
      ({
        number: next++,
        title: input.title,
        body: input.body,
        state: "open",
        authorId: 777,
        authorLogin: "archangel[bot]",
        authorAssociation: "NONE",
        labels: input.labels,
        updatedAt: new Date().toISOString(),
      }) satisfies GitHubIssue,
  } as unknown as GitHubClient;
  return { gh, labelsAdded };
}

const twoFindings = async () => ({
  findings: [
    { title: "app.ts: negative x returns garbage", body: "Add a failing test for x=-1." },
    { title: "app.ts: zero x divides by zero", body: "Add a failing test for x=0." },
  ],
});

describe("Scout autoPromote (owner opt-in per Scout file)", () => {
  it("promotes at most the host daily cap and records the Scout file hash", async () => {
    const { root, mainSha, broker } = await fixture(AUTO_SCOUT);
    try {
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      const { gh, labelsAdded } = fakeScoutGitHub();
      const res = await runScoutsForProject({ config: makeConfig(), ledger, github: gh, broker, mainSha, invoker: twoFindings });
      expect(res[0]?.filedIssues).toEqual([60, 61]);
      expect(labelsAdded).toEqual([{ n: 60, labels: ["ready-for-agent"] }]);
      expect(ledger.getScoutProposal(60)).toMatchObject({ autoPromoted: true, fileSha256: sha(AUTO_SCOUT) });
      expect(ledger.getScoutProposal(61)?.autoPromoted).toBe(false);
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never auto-promotes from a Scout without autoPromote: true", async () => {
    const { root, mainSha, broker } = await fixture(MANUAL_SCOUT);
    try {
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      const { gh, labelsAdded } = fakeScoutGitHub();
      await runScoutsForProject({ config: makeConfig(), ledger, github: gh, broker, mainSha, invoker: twoFindings });
      expect(labelsAdded).toEqual([]);
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("revokes trust for that exact Scout file after a disagreed or red merge; a new file version starts clean", async () => {
    const { root, mainSha, broker } = await fixture(AUTO_SCOUT);
    try {
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      const { gh, labelsAdded } = fakeScoutGitHub();
      await runScoutsForProject({ config: makeConfig(), ledger, github: gh, broker, mainSha, invoker: twoFindings });
      ledger.upsertThread({ issueNumber: 60, title: "t", themeLabel: null, bodySha256: "b", phase: { kind: "done", outcome: "merged" }, mode: "autonomous", now: 1 });
      (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
        .prepare(
          `INSERT INTO merges (repo, issue_number, pr_number, head_sha, squash_sha, shadow_only, disagreed, day_key, main_watch_json, created_at)
           VALUES ('acme/app', 60, 7, 'h', 's', 0, 1, '2026-11-21', '{"kind":"green"}', 1)`,
        )
        .run();
      expect(ledger.isScoutAutoPromoteRevoked("auto-hunt", sha(AUTO_SCOUT))).toBe(true);
      expect(ledger.isScoutAutoPromoteRevoked("auto-hunt", sha(AUTO_SCOUT + "edited"))).toBe(false);

      // Revoked: even with the daily cap free (cap 5), no new auto-promotion.
      labelsAdded.length = 0;
      await runScoutsForProject({
        config: makeConfig({ scouts: { enabled: true, maxRunsPerDay: 5, maxOpenProposals: 5, maxAutoPromotionsPerDay: 5 } }),
        ledger,
        github: gh,
        broker,
        mainSha,
        invoker: async () => ({ findings: [{ title: "app.ts: another real bug", body: "Failing test for x=2." }] }),
      });
      expect(labelsAdded).toEqual([]);
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("intake accepts a bot-labelled auto-promoted proposal only while its Scout file is unchanged and opted in", async () => {
    const { root, remoteBare, mainSha, broker } = await fixture(AUTO_SCOUT);
    try {
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      const mk = (n: number, title: string): GitHubIssue => ({
        number: n,
        title,
        body: `body ${n}`,
        state: "open",
        authorId: 777,
        authorLogin: "archangel[bot]",
        authorAssociation: "NONE",
        labels: ["agent-proposed", "ready-for-agent"],
        updatedAt: "2026-11-21T00:00:00Z",
      });
      const issues = [mk(70, "auto ok"), mk(71, "stale file hash"), mk(72, "not auto-promoted")];
      const record = (i: GitHubIssue, fileSha256: string, autoPromoted: boolean) =>
        ledger.recordScoutProposal({
          issueNumber: i.number,
          scoutName: "auto-hunt",
          contentSha256: scoutContentHash(i.title, i.body),
          titleFp: normalizeTitleFp(i.title),
          fileSha256,
          autoPromoted,
        });
      record(issues[0]!, sha(AUTO_SCOUT), true);
      record(issues[1]!, sha(MANUAL_SCOUT), true);
      record(issues[2]!, sha(AUTO_SCOUT), false);

      const gh = {
        getRemoteUrlWithToken: async () => remoteBare,
        getBranchTipSha: async () => mainSha,
        listOpenIssuesByLabel: async () => issues,
        verifyLabelActor: async () => false, // the owner applied no labels
        getIssue: async (n: number) => issues.find((i) => i.number === n)!,
        getCheckRunsForRef: async () => [],
      } as unknown as GitHubClient;
      const rec = new Reconciler({
        config: makeConfig({
          scouts: { enabled: false, maxRunsPerDay: 2, maxOpenProposals: 3, maxAutoPromotionsPerDay: 1 },
          maxConcurrentThreads: 1,
        }),
        ledger,
        github: gh,
        broker,
        implementer: { run: async () => ({ ok: false, costUsd: 0, turns: 0, summary: "", transcriptPath: "", aborted: false }) },
        reviewers: { reviewAll: async () => ({ results: [], errors: [] }) },
        notifier: { notifyNeedsYou: async () => {} },
      });
      await rec.tick(Date.now(), { waitForAttempts: false });
      rec.abortAllActive("control");
      await rec.waitForActiveTasks();

      expect(ledger.getThread(70)).not.toBeNull();
      expect(ledger.getThread(71)).toBeNull();
      expect(ledger.getThread(72)).toBeNull();
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
