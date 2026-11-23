import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema, type ArchangelConfig } from "../src/config.js";
import type { OnboardRunner } from "../src/core/onboard.js";
import { Reconciler } from "../src/core/reconciler.js";
import { scanForSecrets } from "../src/core/secrets.js";
import { normalizeTitleFp, runScoutsForProject, scoutContentHash } from "../src/core/scout.js";
import { planWorkflowProposal } from "../src/core/workflow-propose.js";
import type { GitHubClient, GitHubIssue } from "../src/github/client.js";
import { Ledger } from "../src/ledger/store.js";
import { SCOUT_PROMPT, hashOfScout, okWorkflow, workflowFile, workflowJson } from "./helpers/workflow.js";
import { scoutDeps } from "./helpers/scout-deps.js";
import { noCli } from "./helpers/no-cli.js";

const BUG_HUNT = { name: "bug-hunt", schedule: "daily", maxProposals: 2 };
const AUTO_SCOUT = { name: "auto-hunt", schedule: "daily", maxProposals: 2, promotion: "auto" };


const norm = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

function fake(workflow: unknown, prompts: Record<string, string>): OnboardRunner {
  return {
    async run(_cmd, args) {
      const line = args.join(" ");
      if (line.startsWith("repo view")) return "main\n";
      if (line.includes("/git/ref/heads/")) return "tipsha\n";
      if (line.includes("contents/.agents/archangel.json?ref=")) return args.includes("--jq") ? "wblob\n" : norm(workflow);
      const m = /contents\/\.agents\/scouts\/([\w-]+)\.md\?ref=/.exec(line);
      if (m) {
        const p = prompts[m[1]!];
        if (p === undefined) throw new Error("HTTP 404");
        return args.includes("--jq") ? "sblob\n" : p;
      }
      if (line.startsWith("pr list")) return "";
      return "";
    },
  };
}

const wf = (promotion: "auto" | "owner") =>
  workflowFile([{ name: "hunt", schedule: "daily", promotion }], { gate: { testFileGlobs: ["t/*.ts"], testCmd: "npm test" } });

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture(scout: Record<string, unknown> & { name: string }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-autopromote-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(path.join(seed, ".agents", "scouts"), { recursive: true });
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seed, "app.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(seed, ".agents", "scouts", `${scout.name}.md`), `${SCOUT_PROMPT}\n`);
  fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), workflowJson([scout]));
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
describe("Scout engine", () => {
  it("scans and blocks secrets from ever being filed as GitHub issues, and dedupes locally", async () => {
    const { root, remoteBare, mainSha, broker } = await fixture(BUG_HUNT);
    try {
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      const created: Array<{ title: string; body: string; labels: string[] }> = [];
      let nextIssue = 50;

      const gh = {
        listOpenIssuesByLabel: async () => [],
        createIssue: async (input: { title: string; body: string; labels: string[] }) => {
          created.push(input);
          const num = nextIssue++;
          return {
            number: num,
            title: input.title,
            body: input.body,
            state: "open",
            authorId: 777,
            authorLogin: "archangel[bot]",
            authorAssociation: "NONE",
            labels: input.labels,
            updatedAt: new Date().toISOString(),
          } satisfies GitHubIssue;
        },
      } as unknown as GitHubClient;

      const cfg = makeConfig();
      const res = await runScoutsForProject({ ...scoutDeps,
        config: cfg,
        ledger,
        github: gh,
        broker,
        workflow: okWorkflow([BUG_HUNT]),
        mainSha,
        invoker: async () => ({
          findings: [
            {
              title: "Leaked secret exfil attempt",
              body: "Here is the stolen key: sk-ant-secret1234567890123456789012345",
            },
            {
              title: "app.ts: boundary check missing",
              body: "When x is negative, app.ts returns invalid output. Add a failing test for x=-1.",
            },
          ],
        }),
      });

      expect(res).toHaveLength(1);
      expect(res[0]?.blockedSecrets).toBe(1);
      expect(res[0]?.filedIssues).toEqual([50]);
      expect(created).toHaveLength(1);
      expect(created[0]?.labels).toEqual(["agent-proposed"]);

      // Verify local proposal hash recorded & dedupe blocks re-filing on second run
      const prop = ledger.getScoutProposal(50);
      expect(prop?.contentSha256).toBe(scoutContentHash(created[0]!.title, created[0]!.body));
      expect(ledger.hasScoutTitleFingerprint(normalizeTitleFp(created[0]!.title))).toBe(true);

      const res2 = await runScoutsForProject({ ...scoutDeps,
        config: cfg,
        ledger,
        github: gh,
        broker,
        workflow: okWorkflow([BUG_HUNT]),
        mainSha,
        invoker: async () => ({
          findings: [
            {
              title: "app.ts: boundary check missing!",
              body: "Duplicate finding with slight punctuation difference should be deduped.",
            },
          ],
        }),
      });
      expect(res2[0]?.skippedDuplicates).toBe(1);
      expect(res2[0]?.filedIssues).toEqual([]);
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("intake strictly verifies bot proposals (rejects edited body, unknown issue, non-owner label, unset botId=0) and accepts exact owner-promoted proposal", async () => {
    const { root, remoteBare, mainSha, broker } = await fixture(BUG_HUNT);
    try {
      const ledger = new Ledger(":memory:", { repo: "acme/app" });

      const validTitle = "Fix null dereference in parser";
      const validBody = "Repro: pass empty input to Parse().";
      ledger.recordScoutProposal({
        issueNumber: 101,
        scoutName: "bug-hunt",
        contentSha256: scoutContentHash(validTitle, validBody),
        titleFp: normalizeTitleFp(validTitle),
      });
      ledger.recordScoutProposal({
        issueNumber: 102,
        scoutName: "bug-hunt",
        contentSha256: scoutContentHash("Original title", "Original body"),
        titleFp: normalizeTitleFp("Original title"),
      });
      ledger.recordScoutProposal({
        issueNumber: 103,
        scoutName: "bug-hunt",
        contentSha256: scoutContentHash("Valid 103", "Body 103"),
        titleFp: normalizeTitleFp("Valid 103"),
      });

      const issues: GitHubIssue[] = [
        // 101: exact hash, bot author, owner applied ready-for-agent -> ACCEPTED
        {
          number: 101,
          title: validTitle,
          body: validBody,
          state: "open",
          authorId: 777,
          authorLogin: "archangel[bot]",
          authorAssociation: "NONE",
          labels: ["agent-proposed", "ready-for-agent"],
          updatedAt: "2026-11-21T00:00:00Z",
        },
        // 102: bot author, tracked in scout_proposals, BUT body was edited -> REJECTED (H2)
        {
          number: 102,
          title: "Original title",
          body: "Tampered prompt injection body!",
          state: "open",
          authorId: 777,
          authorLogin: "archangel[bot]",
          authorAssociation: "NONE",
          labels: ["agent-proposed", "ready-for-agent"],
          updatedAt: "2026-11-21T00:00:00Z",
        },
        // 103: exact hash, bot author, BUT non-owner applied ready-for-agent -> REJECTED (M2)
        {
          number: 103,
          title: "Valid 103",
          body: "Body 103",
          state: "open",
          authorId: 777,
          authorLogin: "archangel[bot]",
          authorAssociation: "NONE",
          labels: ["agent-proposed", "ready-for-agent"],
          updatedAt: "2026-11-21T00:00:00Z",
        },
        // 104: bot author, NOT in scout_proposals -> REJECTED (H2/H3)
        {
          number: 104,
          title: "Unknown bot issue",
          body: "Not created by Scout",
          state: "open",
          authorId: 777,
          authorLogin: "archangel[bot]",
          authorAssociation: "NONE",
          labels: ["agent-proposed", "ready-for-agent"],
          updatedAt: "2026-11-21T00:00:00Z",
        },
        // 105: missing/ghost author (authorId=0) -> REJECTED (H3)
        {
          number: 105,
          title: "Ghost issue",
          body: "Ghost body",
          state: "open",
          authorId: 0,
          authorLogin: "ghost",
          authorAssociation: "NONE",
          labels: ["agent-proposed", "ready-for-agent"],
          updatedAt: "2026-11-21T00:00:00Z",
        },
      ];

      const gh = {
        getRemoteUrlWithToken: async () => remoteBare,
        getBranchTipSha: async () => mainSha,
        listOpenIssuesByLabel: async () => issues,
        verifyLabelActor: async (issueNum: number) => issueNum !== 103,
        getIssue: async (n: number) => issues.find((i) => i.number === n)!,
        getCheckRunsForRef: async () => [],
      } as unknown as GitHubClient;

      const rec = new Reconciler({ triageInvoker: noCli,
        config: makeConfig({
          scouts: { enabled: false, maxRunsPerDay: 2, maxOpenProposals: 3, maxAutoPromotionsPerDay: 1 },
          maxConcurrentThreads: 1,
        }),
        ledger,
        github: gh,
        broker,
        implementer: {
          run: async () => ({
            ok: false,
            costUsd: 0,
            turns: 0,
            summary: "stub",
            transcriptPath: "",
            aborted: false,
            error: "stop",
          }),
        },
        reviewers: { reviewAll: async () => ({ results: [], errors: [] }) },
        notifier: { notifyNeedsYou: async () => {}, sendDigest: async () => {} },
      });

      await rec.tick(Date.now(), { waitForAttempts: false });
      rec.abortAllActive("control");
      await rec.waitForActiveTasks();

      expect(ledger.getThread(101)).not.toBeNull();
      expect(ledger.getThread(102)).toBeNull();
      expect(ledger.getThread(103)).toBeNull();
      expect(ledger.getThread(104)).toBeNull();
      expect(ledger.getThread(105)).toBeNull();

      // Also verify unset githubAppBotUserId + authorId=0 never fails open
      const ledger2 = new Ledger(":memory:", { repo: "acme/app" });
      const rec2 = new Reconciler({ triageInvoker: noCli,
        config: ConfigSchema.parse({
          githubOwner: "acme",
          githubRepo: "app",
          ownerUserId: 999,
          githubAppId: "123",
          githubInstallationId: 456,
          githubPrivateKeyPem: "fake",
          // githubAppBotUserId intentionally omitted
        }),
        ledger: ledger2,
        github: { ...gh, listOpenIssuesByLabel: async () => [issues[4]!] } as unknown as GitHubClient,
        broker,
        implementer: {
          run: async () => ({ ok: false, costUsd: 0, turns: 0, summary: "", transcriptPath: "", aborted: false }),
        },
        reviewers: { reviewAll: async () => ({ results: [], errors: [] }) },
        notifier: { notifyNeedsYou: async () => {}, sendDigest: async () => {} },
      });
      await rec2.tick(Date.now(), { waitForAttempts: false });
      expect(ledger2.getThread(105)).toBeNull();

      ledger.close();
      ledger2.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("promotes at most the host daily cap and records the Scout trust hash", async () => {
    const { root, mainSha, broker } = await fixture(AUTO_SCOUT);
    try {
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      const { gh, labelsAdded } = fakeScoutGitHub();
      const res = await runScoutsForProject({ ...scoutDeps, config: makeConfig(), ledger, github: gh, broker, workflow: okWorkflow([AUTO_SCOUT]), mainSha, invoker: twoFindings });
      expect(res[0]?.filedIssues).toEqual([60, 61]);
      expect(labelsAdded).toEqual([{ n: 60, labels: ["ready-for-agent"] }]);
      expect(ledger.getScoutProposal(60)).toMatchObject({ autoPromoted: true, fileSha256: hashOfScout(AUTO_SCOUT) });
      expect(ledger.getScoutProposal(61)?.autoPromoted).toBe(false);
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("revokes trust for that exact Scout version after a disagreed or red merge, even from a stale workflow snapshot; an edit to its own entry starts clean", async () => {
    const { root, mainSha, broker } = await fixture(AUTO_SCOUT);
    try {
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      const { gh, labelsAdded } = fakeScoutGitHub();
      await runScoutsForProject({ ...scoutDeps, config: makeConfig(), ledger, github: gh, broker, workflow: okWorkflow([AUTO_SCOUT]), mainSha, invoker: twoFindings });
      ledger.upsertThread({ issueNumber: 60, title: "t", themeLabel: null, bodySha256: "b", phase: { kind: "done", outcome: "merged" }, mode: "autonomous", now: 1 });
      (ledger as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
        .prepare(
          `INSERT INTO merges (repo, issue_number, pr_number, head_sha, squash_sha, shadow_only, disagreed, day_key, main_watch_json, created_at)
           VALUES ('acme/app', 60, 7, 'h', 's', 0, 1, '2026-11-21', '{"kind":"green"}', 1)`,
        )
        .run();
      expect(ledger.isScoutAutoPromoteRevoked("auto-hunt", hashOfScout(AUTO_SCOUT))).toBe(true);
      expect(ledger.isScoutAutoPromoteRevoked("auto-hunt", hashOfScout({ ...AUTO_SCOUT, maxProposals: 1 }))).toBe(false);
      expect(ledger.isScoutAutoPromoteRevoked("auto-hunt", hashOfScout(AUTO_SCOUT, "edited prompt"))).toBe(false);

      // Resolution reflects the revocation; an unrelated edit to the workflow file (gate bound) does not re-arm it.
      const revoked = okWorkflow([AUTO_SCOUT], {
        host: { isRevoked: (n, h) => ledger.isScoutAutoPromoteRevoked(n, h) },
        extra: { gate: { testFileGlobs: ["test/**/*.test.ts"], testCmd: "npm test", maxFiles: 3 } },
      });
      expect(revoked.scouts[0]).toMatchObject({ revoked: true, promotionEffective: { value: "owner", source: "kernel" } });

      // Revoked: even with the daily cap free (cap 5), no new auto-promotion.
      labelsAdded.length = 0;
      await runScoutsForProject({ ...scoutDeps,
        config: makeConfig({ scouts: { enabled: true, maxRunsPerDay: 5, maxOpenProposals: 5, maxAutoPromotionsPerDay: 5 } }),
        ledger,
        github: gh,
        broker,
        workflow: revoked,
        mainSha,
        invoker: async () => ({ findings: [{ title: "app.ts: another real bug", body: "Failing test for x=2." }] }),
      });
      expect(labelsAdded).toEqual([]);

      // A workflow snapshot taken before the revocation (still says auto) cannot re-arm it: the Ledger is re-checked live.
      await runScoutsForProject({ ...scoutDeps, config: makeConfig(), ledger, github: gh, broker, workflow: okWorkflow([AUTO_SCOUT]), mainSha,
        invoker: async () => ({ findings: [{ title: "app.ts: yet another real bug", body: "Failing test for x=3." }] }),
      });
      expect(labelsAdded).toEqual([]);
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("intake accepts a bot-labelled auto-promoted proposal only while its Scout entry and prompt are unchanged and opted in", async () => {
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
      const issues = [mk(70, "auto ok"), mk(71, "stale trust hash"), mk(72, "not auto-promoted")];
      const record = (i: GitHubIssue, fileSha256: string, autoPromoted: boolean) =>
        ledger.recordScoutProposal({
          issueNumber: i.number,
          scoutName: "auto-hunt",
          contentSha256: scoutContentHash(i.title, i.body),
          titleFp: normalizeTitleFp(i.title),
          fileSha256,
          autoPromoted,
        });
      record(issues[0]!, hashOfScout(AUTO_SCOUT), true);
      record(issues[1]!, hashOfScout({ ...AUTO_SCOUT, maxProposals: 1 }), true);
      record(issues[2]!, hashOfScout(AUTO_SCOUT), false);

      const gh = {
        getRemoteUrlWithToken: async () => remoteBare,
        getBranchTipSha: async () => mainSha,
        listOpenIssuesByLabel: async () => issues,
        verifyLabelActor: async () => false, // the owner applied no labels
        getIssue: async (n: number) => issues.find((i) => i.number === n)!,
        getCheckRunsForRef: async () => [],
      } as unknown as GitHubClient;
      const rec = new Reconciler({ triageInvoker: noCli,
        config: makeConfig({
          scouts: { enabled: false, maxRunsPerDay: 2, maxOpenProposals: 3, maxAutoPromotionsPerDay: 1 },
          maxConcurrentThreads: 1,
        }),
        ledger,
        github: gh,
        broker,
        implementer: { run: async () => ({ ok: false, costUsd: 0, turns: 0, summary: "", transcriptPath: "", aborted: false }) },
        reviewers: { reviewAll: async () => ({ results: [], errors: [] }) },
        notifier: { notifyNeedsYou: async () => {}, sendDigest: async () => {} },
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

  it("flags a prompt edit of an auto-promoting Scout as a loosening (it would re-arm a revoked Scout)", async () => {
    const plan = await planWorkflowProposal(fake(wf("auto"), { hunt: "Find bugs.\n" }), "o/r", JSON.stringify(wf("auto")), {
      scoutPrompts: { hunt: "Find bugs. Also anything else you like." },
    });
    expect(plan.changes).toContainEqual({ field: "scouts.hunt.prompt", direction: "loosen" });
    expect(plan.loosens).toBe(true);
    expect(plan.body).not.toContain("No workflow field changes");
  });
});
