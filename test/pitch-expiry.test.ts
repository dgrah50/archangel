import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { buildDigest } from "../src/core/digest.js";
import { PITCH_EXPIRY_DAYS, expireStalePitches } from "../src/core/pitch-expiry.js";
import { Reconciler } from "../src/core/reconciler.js";
import { describeWorkflow, pitchMetricLines } from "../src/core/ui-state.js";
import { Ledger, PITCH_RATE_WINDOW } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson, okWorkflow } from "./helpers/workflow.js";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const OWNER = 999;
const LABELS = { agentPitch: "agent-pitch" } as never;
const cfg = { labels: LABELS, ownerUserId: OWNER };

function pitch(l: Ledger, n: number, ageDays: number, hash = "h1") {
  l.recordPitch({ issueNumber: n, scoutName: "pitch", trustHash: hash, title: `Pitch number ${n}`, titleFp: `fp${n}`, contentSha256: `c${n}`, pitchJson: "{}", now: NOW - ageDays * DAY });
}
function openOnGitHub(gh: FakeGitHub, ...issues: number[]) {
  for (const n of issues) {
    gh.issues.set(n, { number: n, title: `Pitch number ${n}`, body: "b", state: "open", authorId: 777, authorLogin: "bot", authorAssociation: "NONE", labels: ["agent-pitch"], updatedAt: "" });
  }
}
const fake = () => new FakeGitHub("/nonexistent");

describe("pitch expiry isolation", () => {
  it("one pitch failing to expire does not block the others, and the failure is logged", async () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const gh = fake();
    pitch(l, 1, 20);
    pitch(l, 2, 20);
    openOnGitHub(gh, 1, 2);
    const real = gh.closeIssue.bind(gh);
    gh.closeIssue = async (n: number) => {
      if (n === 1) throw new Error("boom");
      await real(n);
    };
    const logs: string[] = [];
    expect(await expireStalePitches(l, gh, cfg, NOW, (e, m) => void logs.push(`${e} ${m}`))).toEqual([2]);
    expect(l.getPitch(1)!.state.kind).toBe("open");
    expect(logs.some((x) => x.startsWith("pitch/expiry_failed #1"))).toBe(true);
  });

  it("a lost decline reason is logged", async () => {
    const { syncPitchDecisions } = await import("../src/core/pitch-expiry.js");
    const l = new Ledger(":memory:", { repo: "a/b" });
    const gh = fake();
    pitch(l, 1, 3); // its issue is not open on GitHub: declined
    gh.listOwnerCommentsSince = async () => {
      throw new Error("comments down");
    };
    const logs: string[] = [];
    await syncPitchDecisions(l, gh, cfg, NOW, (e, m) => void logs.push(`${e} ${m}`));
    expect(logs.some((x) => x.includes("pitch/decline_reason_failed") && x.includes("comments down"))).toBe(true);
  });
});

describe("pitch expiry", () => {
  it("closes an open pitch nobody decided in 14 days with a short comment, and records it as expired", async () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const gh = fake();
    pitch(l, 1, PITCH_EXPIRY_DAYS + 1);
    pitch(l, 2, PITCH_EXPIRY_DAYS - 1); // not old enough
    openOnGitHub(gh, 1, 2);
    const comments: string[] = [];
    gh.postComment = async (_n, body) => void comments.push(body);
    expect(await expireStalePitches(l, gh, cfg, NOW)).toEqual([1]);
    expect(gh.closedIssues).toEqual([1]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("expired");
    expect(l.getPitch(1)!.state.kind).toBe("expired");
    expect(l.pitchMetrics(0)).toMatchObject({ expired: 1, declined: 0, open: 1 });
    expect(l.listAudit({ topicPrefix: "pitch/expired" })).toHaveLength(1);
    // idempotent: nothing left to expire
    expect(await expireStalePitches(l, gh, cfg, NOW)).toEqual([]);
  });

  it("leaves a pitch alone when the owner engaged with it, or when it was already closed another way", async () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const gh = fake();
    pitch(l, 1, 20);
    pitch(l, 2, 20);
    openOnGitHub(gh, 1); // #2's issue is closed on GitHub: the decline sync records that, not the expiry
    gh.addComment(1, OWNER, "interesting, let me think", NOW - 3 * DAY);
    expect(await expireStalePitches(l, gh, cfg, NOW)).toEqual([]);
    expect(gh.closedIssues).toEqual([]);
    expect(l.getPitch(1)!.state.kind).toBe("open");
    expect(l.getPitch(2)!.state.kind).toBe("open");
  });

  it("retries next time when closing fails, and records nothing", async () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const gh = fake();
    pitch(l, 1, 20);
    openOnGitHub(gh, 1);
    gh.closeIssue = async () => {
      throw new Error("github down");
    };
    const logs: string[] = [];
    expect(await expireStalePitches(l, gh, cfg, NOW, (e, m) => void logs.push(`${e} ${m}`))).toEqual([]);
    expect(logs[0]).toContain("github down");
    expect(l.getPitch(1)!.state.kind).toBe("open");
    expect(l.listAudit({ topicPrefix: "pitch/expired" })).toHaveLength(0);
  });

  it("counts as unpromoted for the pause rule: four expired pitches pause the Scout, a promoted one in the last four does not", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    for (const n of [1, 2, 3, 4]) {
      pitch(l, n, 40 - n);
      l.markPitchExpired(n, NOW);
    }
    expect(l.isPitchScoutPaused("pitch", "h1", 4)).toBe(true);
    expect(l.isPitchScoutPaused("pitch", "other-hash", 4)).toBe(false); // editing the Scout resumes it

    const m = new Ledger(":memory:", { repo: "a/b" });
    for (const n of [1, 2, 3, 4]) pitch(m, n, 40 - n);
    for (const n of [1, 2, 4]) m.markPitchExpired(n, NOW);
    m.markPitchSlicesPromoted(3, [0], 1, NOW);
    expect(m.isPitchScoutPaused("pitch", "h1", 4)).toBe(false);
  });

  it("runs every tick from the reconciler, closing the stale pitch without any Scout run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-pexp-"));
    const git = (cwd: string, a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
    try {
      const seed = path.join(root, "seed");
      fs.mkdirSync(path.join(seed, ".agents"), { recursive: true });
      git(seed, ["init", "-q", "-b", "main"]);
      git(seed, ["config", "user.name", "T"]);
      git(seed, ["config", "user.email", "t@t"]);
      fs.writeFileSync(path.join(seed, "a.txt"), "x");
      fs.writeFileSync(path.join(seed, ".agents", "archangel.json"), goWorkflowJson());
      git(seed, ["add", "-A"]);
      git(seed, ["commit", "-qm", "i"]);
      git(root, ["clone", "-q", "--bare", seed, path.join(root, "remote.git")]);
      const gh = new FakeGitHub(path.join(root, "remote.git"));
      const ledger = new Ledger(":memory:", { repo: "acme/app" });
      pitch(ledger, 7, 20);
      openOnGitHub(gh, 7);
      const conf = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: OWNER, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
      const rec = new Reconciler({
        config: conf, ledger, github: gh, broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
        implementer: { async run() { throw new Error("unused"); } },
        reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
        notifier: { async notifyNeedsYou() {}, async sendDigest() {} },
      });
      await rec.tick(Date.now(), { waitForAttempts: true });
      // the pitch was filed 20 days before `NOW`, which is long before the real clock's tick: expired
      expect(gh.closedIssues).toEqual([7]);
      expect(ledger.pitchMetrics(0).expired).toBe(1);
      ledger.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("pitch metrics", () => {
  it("counts filed, promoted, declined, expired, vetoed and open pitches, and the promotion rate over the last decided", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    for (let n = 1; n <= 9; n++) pitch(l, n, 10 - n * 0.5); // #1 oldest ... #9 newest, all inside the window
    l.markPitchSlicesPromoted(1, [0], 1, NOW); // oldest decided
    l.markPitchExpired(2, NOW);
    l.syncPitchStatuses([3, 9], NOW); // 3 and 9 stay open; the rest not listed: closed by the owner
    // statuses now: 1 promoted, 2 expired, 3 open, 4-8 declined, 9 open
    l.appendAudit("pitch/vetoed", null, "pitch", {}, NOW - DAY);
    l.appendAudit("pitch/vetoed", null, "pitch", {}, NOW - 30 * DAY); // outside the window
    const m = l.pitchMetrics(NOW - 14 * DAY);
    expect(m).toMatchObject({ filed: 9, promoted: 1, declined: 5, expired: 1, open: 2, vetoed: 1 });
    // the last 6 decided (newest first): 8,7,6,5,4,2 -> none promoted (the promoted one, #1, is older than the window of 6)
    expect(m.lastDecided).toBe(PITCH_RATE_WINDOW);
    expect(m.lastDecidedPromoted).toBe(0);
    l.markPitchSlicesPromoted(3, [0], 1, NOW); // #3 was still open: now decided and promoted, inside the last 6
    expect(l.pitchMetrics(0).lastDecidedPromoted).toBe(1);
  });

  it("shows on the Scouts stage card (and only when there is pitch activity), including through computeStageMetrics", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    expect(pitchMetricLines(l.pitchMetrics(0))).toEqual([]);
    pitch(l, 1, 3);
    pitch(l, 2, 2);
    l.markPitchSlicesPromoted(1, [0], 1, NOW);
    l.markPitchExpired(2, NOW);
    const sm = l.computeStageMetrics("a/b", NOW - 14 * DAY, NOW);
    expect(sm.pitches).toMatchObject({ filed: 2, promoted: 1, expired: 1 });
    const card = describeWorkflow("a/b", okWorkflow(), sm).stages.find((s) => s.id === "scouts")!;
    expect(card.metrics).toContain("pitches (14d): 2 filed, 1 promoted, 0 declined, 1 expired, 0 vetoed; 0 open");
    expect(card.metrics).toContain("pitch promotion rate (last 2 decided): 1/2");
  });
});

describe("digest", () => {
  const base = { now: NOW, needsYou: [], proposals: [], yesterday: { autonomousMerges: 0, ownerMerges: 0, reverts: 0, spendUsd: 0 } };
  it("lists open pitches awaiting the owner, and an open pitch keeps an otherwise quiet digest alive", () => {
    expect(buildDigest({ ...base, pitches: [] })).toBeNull();
    const text = buildDigest({ ...base, pitches: [{ repo: "a/b", issueNumber: 7, scoutName: "pitch", since: NOW - 3 * DAY }] })!;
    expect(text).toContain("Pitches awaiting you (1; they close unanswered after 14 days):");
    expect(text).toContain("a/b#7 (pitch), open 3d");
    expect(buildDigest({ ...base, pitches: null })).toContain("Pitches awaiting you: unavailable"); // an unreadable list is never treated as empty, even on a quiet day
  });
  it("reads the open pitches from the Ledger", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    pitch(l, 7, 3);
    pitch(l, 8, 3);
    l.markPitchExpired(8, NOW);
    expect(l.collectDigestInput(NOW).pitches).toEqual([{ repo: "a/b", issueNumber: 7, scoutName: "pitch", since: NOW - 3 * DAY }]);
  });
});
