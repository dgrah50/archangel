import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema, type ArchangelConfig } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import {
  buildScoutCliArgs,
  normalizeTitleFp,
  parseScoutMarkdown,
  runScoutsForProject,
  scanForSecrets,
  scoutContentHash,
  selectScoutProvider,
} from "../src/core/scout.js";
import type { GitHubClient, GitHubIssue } from "../src/github/client.js";
import { Ledger } from "../src/ledger/store.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeScoutFixtureRepo(): { root: string; remoteBare: string; mainSha: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-scout-test-"));
  const seed = path.join(root, "seed");
  const remoteBare = path.join(root, "remote.git");
  fs.mkdirSync(path.join(seed, ".agents", "scouts"), { recursive: true });
  git(seed, ["init", "-b", "main"]);
  git(seed, ["config", "user.name", "Test"]);
  git(seed, ["config", "user.email", "test@example.com"]);
  fs.writeFileSync(path.join(seed, "app.ts"), "export const x = 1;\n");
  fs.writeFileSync(
    path.join(seed, ".agents", "scouts", "bug-hunt.md"),
    `---\nname: bug-hunt\nschedule: daily\nmaxProposals: 2\n---\nFind real bugs in app.ts.\n`,
  );
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-m", "initial"]);
  const mainSha = git(seed, ["rev-parse", "HEAD"]);
  git(root, ["clone", "--bare", seed, remoteBare]);
  return { root, remoteBare, mainSha };
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
    scouts: { enabled: true, maxRunsPerDay: 2, maxOpenProposals: 3, maxAutoPromotionsPerDay: 1 },
    ...overrides,
  });
}

describe("V2.0 Scout Engine security & behavior (Opus H1-H3, M1-M5)", () => {
  it("enforces hardened read-only CLI flags for claude (H1) and excludes agy", () => {
    const args = buildScoutCliArgs("claude", {
      cloneDir: "/tmp/clone",
      schemaStr: '{"type":"object"}',
      schemaFile: "/tmp/s.json",
      outFile: "/tmp/o.json",
    });
    expect(args).toContain("--permission-mode");
    expect(args).toContain("plan");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--setting-sources");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--no-session-persistence");

    // agy is excluded from Scout provider selection
    expect(selectScoutProvider([{ provider: "agy" }])).toBeNull();
    expect(selectScoutProvider([{ provider: "agy" }, { provider: "claude" }])).toEqual({
      provider: "claude",
      model: undefined,
    });
  });

  it("blocks config when scouts.enabled=true without githubAppBotUserId (H3)", () => {
    expect(() =>
      ConfigSchema.parse({
        githubOwner: "acme",
        githubRepo: "app",
        ownerUserId: 999,
        githubAppId: "123",
        githubInstallationId: 456,
        githubPrivateKeyPem: "fake",
        scouts: { enabled: true, maxRunsPerDay: 2, maxOpenProposals: 3, maxAutoPromotionsPerDay: 1 },
      }),
    ).toThrow(/githubAppBotUserId/);
  });

  it("scans and blocks secrets from ever being filed as GitHub issues, and dedupes locally (H1, M3, M4)", async () => {
    expect(scanForSecrets("normal bug report")).toBeNull();
    expect(scanForSecrets("token ghp_1234567890abcdefghij12345")).toBe("github_token");
    expect(scanForSecrets("key sk-proj-abcdefghijklmnopqrstuvwx")).toBe("openai_anthropic_key");
    expect(scanForSecrets("-----BEGIN RSA PRIVATE KEY-----")).toBe("private_key_header");

    const { root, remoteBare, mainSha } = makeScoutFixtureRepo();
    try {
      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
      });
      await broker.ensureBareRepo(remoteBare);
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
      const res = await runScoutsForProject({
        config: cfg,
        ledger,
        github: gh,
        broker,
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

      const res2 = await runScoutsForProject({
        config: cfg,
        ledger,
        github: gh,
        broker,
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

  it("intake strictly verifies bot proposals (rejects edited body, unknown issue, non-owner label, unset botId=0) and accepts exact owner-promoted proposal (H2, H3, M1, M2)", async () => {
    const { root, remoteBare, mainSha } = makeScoutFixtureRepo();
    try {
      const broker = new GitBroker({
        bareRepoPath: path.join(root, "broker.git"),
        clonesDir: path.join(root, "clones"),
      });
      await broker.ensureBareRepo(remoteBare);
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

      const rec = new Reconciler({
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
      const rec2 = new Reconciler({
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

  it("parses scout frontmatter strictly and rejects unknown keys", () => {
    const wf = parseScoutMarkdown("---\nname: my-scout\nschedule: daily\nmaxProposals: 2\n---\nAudit src/.\n", "a.md");
    expect(wf).toMatchObject({ name: "my-scout", schedule: "daily", maxProposals: 2, prompt: "Audit src/." });
    expect(() =>
      parseScoutMarkdown("---\nname: bad\nscope: ['src/**']\n---\nBody\n", "b.md"),
    ).toThrow();
  });
});
