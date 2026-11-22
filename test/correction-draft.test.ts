import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler, type CorrectionDraftDeps } from "../src/core/reconciler.js";
import {
  DRAFT_GLOBAL_PER_WEEK,
  DRAFT_PER_CATEGORY_DAYS,
  applyDraftPatch,
  draftCorrection,
  measureDrafts,
  rubricOnlyChange,
  validateDraft,
  type DraftDeps,
} from "../src/core/correction-draft.js";
import { buildDigest } from "../src/core/digest.js";
import type { EvalReport } from "../src/core/eval.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const CAT = "owner_retry:gate_failed";
const ctx = { category: CAT, count: 3, windowDays: 30 };
const SKILL_DIFF = [
  "diff --git a/skills/general/gate-first.md b/skills/general/gate-first.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/skills/general/gate-first.md",
  "@@ -0,0 +1,2 @@",
  "+# Run the gate first",
  "+Run the local gate before pushing.",
  "",
].join("\n");
const GOOD = { target: "skill", file: "skills/general/gate-first.md", diff: SKILL_DIFF, rationale: `Three corrections in ${CAT} suggest the gate is run too late.` };
const report = (result: EvalReport["result"], reasons: string[] = []): EvalReport =>
  ({
    split: "dev",
    candidate: { patchSha256: "p", files: ["skills/general/gate-first.md"], touchesSkills: true },
    counts: { total: 30, dev: 20, heldout: 10, good: 15, bad: 15, disputes: 0, mutants: 5, unreplayable: 0, withoutIssueText: 0 },
    milestones: { current: 30, next: null }, selected: 20, scored: { good: 10, bad: 10 }, errors: 0, cacheHits: 0,
    baseline: { falseApprovals: [], falseVetoes: [] }, candidateArm: { falseApprovals: [], falseVetoes: [] },
    newFalseApprovals: [], newFalseVetoes: [], fixedFalseApprovals: [], fixedFalseVetoes: [], allowedNewFalseVetoes: 1,
    result, reasons,
  }) as EvalReport;

function deps(ledger: Ledger, over: Partial<DraftDeps> = {}) {
  const invoker = vi.fn(async (_i: unknown) => GOOD as unknown);
  const evaluate = vi.fn(async (_p: string, _h: boolean) => report("pass"));
  const openPr = vi.fn(async (_d: unknown, _b: string, _c: unknown) => "https://github.com/dgrah50/archangel/pull/900");
  const d: DraftDeps = { ledger, chain: [{ provider: "claude" }, { provider: "codex" }], invoker, cwd: "/tmp", skills: ["general/bug-hunt"], evaluate, openPr, ...over };
  return { d, invoker, evaluate, openPr };
}

describe("validateDraft", () => {
  it("accepts one allowed file whose diff changes only that file", () => {
    expect(validateDraft(GOOD, ctx).ok).toBe(true);
  });
  it.each([
    ["a file outside the allowed set", { ...GOOD, file: "src/core/reconciler.ts", target: "prompt" }],
    ["a target that does not match the file", { ...GOOD, target: "prompt" }],
    ["a diff that touches another file too", { ...GOOD, diff: `${SKILL_DIFF}diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n+x\n` }],
    ["a diff for a different file", { ...GOOD, file: "skills/general/other.md" }],
    ["a rationale that does not cite the category", { ...GOOD, rationale: "make it better" }],
    ["a secret", { ...GOOD, diff: SKILL_DIFF.replace("Run the local gate", "AKIAABCDEFGHIJKLMNOP") }],
    ["an extra key", { ...GOOD, extra: 1 }],
    ["too many added lines", { ...GOOD, diff: SKILL_DIFF + Array.from({ length: 70 }, (_, i) => `+line ${i}`).join("\n") + "\n" }],
  ])("rejects %s", (_n, raw) => {
    expect(validateDraft(raw, ctx).ok).toBe(false);
  });
});

describe("draftCorrection", () => {
  it("opens a PR only when the dev set and then the held-out set both pass, with both reports in the body", async () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    try {
      const { d, evaluate, openPr, invoker } = deps(l);
      const out = await draftCorrection(d, ctx, NOW);
      expect(out.kind).toBe("pr_opened");
      expect(evaluate.mock.calls.map((c) => c[1])).toEqual([false, true]);
      expect(openPr).toHaveBeenCalledTimes(1);
      const body = openPr.mock.calls[0]![1];
      expect(body).toContain("Eval, dev set");
      expect(body).toContain("Eval, held-out set");
      expect(body).toContain(CAT);
      expect(body).toContain("Machine-drafted; owner review required");
      expect(body).toContain("agent-draft/*");
      expect(invoker.mock.calls[0]![0]).toMatchObject({ provider: "claude", maxProposals: 0 });
    } finally {
      l.close();
    }
  });

  it("a dev failure stops before the held-out set and opens no PR", async () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    try {
      const { d, evaluate, openPr } = deps(l, { evaluate: vi.fn(async () => report("fail", ["1 new false approval"])) });
      const out = await draftCorrection(d, ctx, NOW);
      expect(out).toMatchObject({ kind: "eval_failed", split: "dev", result: "fail" });
      expect((d.evaluate as typeof evaluate).mock.calls).toHaveLength(1);
      expect(openPr).not.toHaveBeenCalled();
    } finally {
      l.close();
    }
  });

  it("insufficient data and a held-out failure and an eval error all stay unlanded", async () => {
    for (const [ev, expected] of [
      [async () => report("insufficient", ["only 3 replayable dev case(s)"]), { kind: "eval_failed", split: "dev", result: "insufficient" }],
      [async (_p: string, h: boolean) => report(h ? "fail" : "pass", ["new false veto"]), { kind: "eval_failed", split: "heldout", result: "fail" }],
      [async () => { throw new Error("reviewer CLI missing"); }, { kind: "eval_error" }],
    ] as const) {
      const l = new Ledger(":memory:", { repo: "a/b" });
      try {
        const { d, openPr } = deps(l, { evaluate: vi.fn(ev) });
        expect(await draftCorrection(d, ctx, NOW)).toMatchObject(expected);
        expect(openPr).not.toHaveBeenCalled();
      } finally {
        l.close();
      }
    }
  });

  it("an invalid draft is never evaluated, and a failed run still counts as the attempt", async () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    try {
      const bad = deps(l, { invoker: vi.fn(async () => ({ ...GOOD, file: "src/core/reconciler.ts" })) });
      expect((await draftCorrection(bad.d, ctx, NOW)).kind).toBe("invalid");
      expect(bad.evaluate).not.toHaveBeenCalled();
      expect((await draftCorrection(deps(l).d, ctx, NOW + 1)).kind).toBe("skipped"); // the attempt was recorded
      const crash = new Ledger(":memory:", { repo: "a/b" });
      const c = deps(crash, { invoker: vi.fn(async () => { throw new Error("cli exploded"); }) });
      expect((await draftCorrection(c.d, ctx, NOW)).kind).toBe("run_failed");
      expect(crash.hasAudit({ topic: "correction_draft/attempt", payload: { key: "category", value: CAT } })).toBe(true);
      crash.close();
    } finally {
      l.close();
    }
  });

  it("at most one draft per category per 30 days, and two per week across all repos", async () => {
    const root = new Ledger(":memory:");
    try {
      const a = root.forRepo("a/a");
      const b = root.forRepo("b/b");
      const dep = (l: Ledger, cat: string) => deps(l, { invoker: vi.fn(async () => ({ ...GOOD, rationale: `Corrections in ${cat} repeat.` })) }).d;
      expect((await draftCorrection(deps(a).d, ctx, NOW)).kind).toBe("pr_opened");
      expect(await draftCorrection(deps(a).d, ctx, NOW + 5 * DAY)).toMatchObject({ kind: "skipped", why: "category_limit" });
      expect((await draftCorrection(dep(b, "disagree"), { ...ctx, category: "disagree" }, NOW + 1 * DAY)).kind).toBe("pr_opened"); // second this week, other repo
      expect(await draftCorrection(dep(a, "revert"), { ...ctx, category: "revert" }, NOW + 2 * DAY)).toMatchObject({ kind: "skipped", why: "weekly_limit" });
      expect((await draftCorrection(dep(a, "revert"), { ...ctx, category: "revert" }, NOW + 8 * DAY)).kind).toBe("pr_opened");
      expect((await draftCorrection(deps(a).d, ctx, NOW + DRAFT_PER_CATEGORY_DAYS * DAY + DAY)).kind).toBe("pr_opened"); // the month passed
      expect(DRAFT_GLOBAL_PER_WEEK).toBe(2);
    } finally {
      root.close();
    }
  });

  it("is skipped, not attempted, when the Scout chain has no read-only provider", async () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    try {
      const { d, invoker } = deps(l, { chain: [{ provider: "agy" }] });
      expect(await draftCorrection(d, ctx, NOW)).toMatchObject({ kind: "skipped", why: "no_provider" });
      expect(invoker).not.toHaveBeenCalled();
    } finally {
      l.close();
    }
  });
});

describe("applying a draft", () => {
  it("applies a diff to one file's content in a scratch directory", async () => {
    const out = await applyDraftPatch("skills/general/x.md", "a\nb\n", ["diff --git a/skills/general/x.md b/skills/general/x.md", "--- a/skills/general/x.md", "+++ b/skills/general/x.md", "@@ -1,2 +1,3 @@", " a", " b", "+c", ""].join("\n"));
    expect(out).toBe("a\nb\nc\n");
    expect(await applyDraftPatch("skills/general/gate-first.md", null, SKILL_DIFF)).toContain("Run the gate first");
    await expect(applyDraftPatch("skills/general/x.md", "zzz\n", SKILL_DIFF.replace("/dev/null", "a/skills/general/x.md").replace("new file mode 100644\n", ""))).rejects.toThrow();
  });
  it("a rubric draft may change review.rubric and nothing else", () => {
    const before = JSON.stringify({ version: 1, review: { rubric: "a" }, landing: { bugfix: "owner" } });
    expect(rubricOnlyChange(before, JSON.stringify({ version: 1, review: { rubric: "b" }, landing: { bugfix: "owner" } }))).toBe(true);
    expect(rubricOnlyChange(before, JSON.stringify({ version: 1, review: { rubric: "b" }, landing: { bugfix: "autonomous" } }))).toBe(false);
    expect(rubricOnlyChange(before, "not json")).toBe(false);
  });
});

describe("measurement and the digest", () => {
  const opened = (l: Ledger, url: string, count = 3) => l.appendAudit("correction_draft/pr_opened", null, "archangel", { category: CAT, count, url }, NOW - 60 * DAY);
  it("flags a merged draft for revert when the category did not drop 30 days after the merge, and keeps one that helped", async () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    try {
      opened(l, "u/1");
      opened(l, "u/2");
      opened(l, "u/3");
      opened(l, "u/4");
      opened(l, "u/5");
      const status = async (u: string) =>
        u === "u/1" ? { state: "merged" as const, mergedAt: NOW - 31 * DAY }
        : u === "u/2" ? { state: "merged" as const, mergedAt: NOW - 31 * DAY }
        : u === "u/3" ? { state: "closed" as const, mergedAt: null }
        : u === "u/4" ? { state: "merged" as const, mergedAt: NOW - 5 * DAY }
        : { state: "open" as const, mergedAt: null };
      let after = 3;
      await measureDrafts(l, status, () => after, NOW); // u/1 (not lower) flagged, u/2 flagged too at the same count
      after = 1;
      expect(l.listAudit({ topicPrefix: "correction_draft/revert_flag" })).toHaveLength(2);
      await measureDrafts(l, status, () => after, NOW + 1); // already measured: no second row
      expect(l.listAudit({ topicPrefix: "correction_draft/revert_flag" })).toHaveLength(2);
      expect(l.listAudit({ topicPrefix: "correction_draft/closed" })).toHaveLength(1);
      expect(l.listAudit({ topicPrefix: "correction_draft/kept" })).toHaveLength(0);
      const helped = new Ledger(":memory:", { repo: "a/b" });
      opened(helped, "u/9", 3);
      await measureDrafts(helped, async () => ({ state: "merged", mergedAt: NOW - 40 * DAY }), () => 1, NOW);
      expect(helped.listAudit({ topicPrefix: "correction_draft/kept" })).toHaveLength(1);
      expect(helped.listAudit({ topicPrefix: "correction_draft/revert_flag" })).toHaveLength(0);
      helped.close();
    } finally {
      l.close();
    }
  });

  it("an unreadable PR is looked at again, never guessed", async () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    try {
      opened(l, "u/1");
      await measureDrafts(l, async () => { throw new Error("gh down"); }, () => 9, NOW);
      expect(l.listAudit({ topicPrefix: "correction_draft/" }).filter((a) => !a.topic.endsWith("pr_opened"))).toHaveLength(0);
    } finally {
      l.close();
    }
  });

  it("the digest lists flagged drafts and a flagged draft keeps a quiet digest alive", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    try {
      l.appendAudit("correction_draft/revert_flag", null, "archangel", { category: CAT, url: "u/1", before: 3, after: 4 }, NOW - DAY);
      const input = l.collectDigestInput(NOW);
      expect(input.draftReverts).toEqual([{ repo: "a/b", category: CAT, url: "u/1", before: 3, after: 4 }]);
      const text = buildDigest({ ...input, needsYou: [], proposals: [], pitches: [], faults: [], yesterday: { autonomousMerges: 0, ownerMerges: 0, reverts: 0, spendUsd: 0 } })!;
      expect(text).toContain("did not help");
      expect(text).toContain(`${CAT}: 3 corrections before, 4`);
    } finally {
      l.close();
    }
  });
});

describe("the Reconciler drafts when a category crosses its threshold", () => {
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  function world(drafts?: Partial<CorrectionDraftDeps>) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-draftrec-"));
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
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    const notes: Array<{ title: string; reason: string }> = [];
    const full: CorrectionDraftDeps = {
      invoker: vi.fn(async () => GOOD as unknown) as never,
      cwd: root,
      skills: [],
      evaluate: vi.fn(async () => report("pass")),
      openPr: vi.fn(async () => "https://github.com/dgrah50/archangel/pull/901"),
      prStatus: vi.fn(async () => ({ state: "open" as const, mergedAt: null })),
      ...drafts,
    };
    const rec = new Reconciler({
      config: ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" }),
      ledger,
      github: new FakeGitHub(path.join(root, "remote.git")),
      broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
      implementer: { run: (async () => { throw new Error("unused"); }) as never },
      reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
      notifier: { async notifyNeedsYou(i) { notes.push(i); }, async sendDigest() {} },
      correctionDrafts: drafts === undefined ? undefined : full,
    });
    for (const n of [1, 2]) ledger.appendAudit("thread/owner_retry", n, "owner", { code: "gate_failed" }, Date.now());
    const raise = async () => {
      await (rec as unknown as { raiseCorrectionSignals: (n: number) => Promise<void> }).raiseCorrectionSignals(Date.now());
      await rec.waitForActiveTasks();
    };
    return { ledger, notes, full, raise, cleanup: () => { ledger.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
  }

  it("also drafts one change: eval passes, a PR is opened and recorded with the category count", async () => {
    const w = world({});
    try {
      await w.raise();
      expect(w.notes.filter((n) => n.title.includes("Owner corrections repeat"))).toHaveLength(1);
      expect(w.full.openPr).toHaveBeenCalledTimes(1);
      const row = w.ledger.listAudit({ topicPrefix: "correction_draft/pr_opened" })[0]!;
      expect(JSON.parse(row.payloadJson)).toMatchObject({ category: CAT, count: 2, url: "https://github.com/dgrah50/archangel/pull/901" });
      await w.raise(); // the Needs You is once per category per window, and so is the draft
      expect(w.full.openPr).toHaveBeenCalledTimes(1);
    } finally {
      w.cleanup();
    }
  });

  it("a draft whose eval had too little data is posted as a Needs You follow-up instead of a PR", async () => {
    const w = world({ evaluate: vi.fn(async () => report("insufficient", ["only 3 replayable dev case(s) scored"])) });
    try {
      await w.raise();
      expect(w.full.openPr).not.toHaveBeenCalled();
      const follow = w.notes.find((n) => n.title.startsWith("Correction draft not landed"));
      expect(follow?.reason).toContain("INSUFFICIENT DATA");
      expect(follow?.reason).toContain("Run the gate first");
      expect(w.ledger.listAudit({ topicPrefix: "correction_draft/not_landed" })).toHaveLength(1);
    } finally {
      w.cleanup();
    }
  });

  it("makes no draft at all when drafting is not wired", async () => {
    const w = world(undefined);
    try {
      await w.raise();
      expect(w.notes).toHaveLength(1);
      expect(w.ledger.listAudit({ topicPrefix: "correction_draft/" })).toHaveLength(0);
    } finally {
      w.cleanup();
    }
  });
});
