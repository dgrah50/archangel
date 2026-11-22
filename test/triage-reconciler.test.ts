import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, mock, spyOn } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import type { ScoutCliInvoker } from "../src/core/scout.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson, okWorkflow } from "./helpers/workflow.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
type Priv = {
  spawnAttempt: (...a: unknown[]) => Promise<boolean>;
  applyMachineEvent: (...a: unknown[]) => { version: number } | null;
  runTriage: (...a: unknown[]) => Promise<void>;
  checkFactoryAutoOff: (...a: unknown[]) => Promise<void>;
  workflow: unknown;
};
const sql = (l: Ledger, q: string, ...a: unknown[]) => (l as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } }).db.prepare(q).run(...a);
const GOOD = { decision: "guidance", cause: "scope_too_broad", guidance: "Narrow it.", steps: ["In `app.go` remove the extra branch"], keepUnchanged: [], escalateReason: "" };

function world(opts: { knob?: "off" | "once"; invoker?: ScoutCliInvoker; vendors?: string[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-triage-"));
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
  const github = new FakeGitHub(path.join(root, "remote.git"));
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
  const notes: string[] = [];
  const broker = new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") });
  const invoker = mock<ScoutCliInvoker>(opts.invoker ?? (async () => GOOD));
  const rec = new Reconciler({
    config: cfg, ledger, github, broker,
    implementer: { run: (async () => { throw new Error("unused"); }) as never },
    reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
    notifier: { async notifyNeedsYou(i) { notes.push(i.title); }, async sendDigest() {} },
    triageInvoker: invoker,
  });
  (rec as unknown as Priv).workflow = okWorkflow([], { extra: { escalations: { factoryRetry: opts.knob ?? "once" } } });
  github.issues.set(4, { number: 4, title: "Bug", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: "" });
  spyOn(broker, "getDiffAndTouchedFiles").mockResolvedValue({ diffText: "+x", touchedFiles: {} });
  spyOn(broker, "createThrowawayClone").mockResolvedValue(path.join(root, "clone"));
  spyOn(broker, "readFileAtRef").mockImplementation(async (_ref, p) => (p === "app.go" ? "package demo\n" : null));
  const spawn = spyOn(rec as unknown as Priv, "spawnAttempt").mockResolvedValue(true);
  ledger.upsertThread({ issueNumber: 4, title: "Bug", bodySha256: "x", phase: { kind: "awaiting_gate", prNumber: 9, headSha: "h", baseSha: "b", since: 1, nudgedAt: null } });
  sql(ledger, "UPDATE threads SET implementer_vendors_json = ? WHERE issue_number = 4", JSON.stringify(opts.vendors ?? ["anthropic"]));
  const review = (vendor: "openai" | "anthropic" | "gemini", verdict: "approve" | "veto") =>
    ledger.recordReview({ issueNumber: 4, headSha: "h", vendor, verdict, findings: [], costUsd: 0 });
  const escalate = (code = "review_vetoed") =>
    (rec as unknown as Priv).applyMachineEvent(ledger.getThread(4), { t: "escalate", code, reason: "vetoed" }, {});
  const triage = () => (rec as unknown as Priv).runTriage(ledger.getThread(4), github.issues.get(4), "mainsha", Date.now());
  return { root, ledger, rec, spawn, invoker, notes, review, escalate, triage, cleanup: () => { ledger.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}
const outbox = (l: Ledger) => l.listDueOutbox().map((o) => o.effect?.kind);

describe("holding the escalation while triage decides", () => {
  it("queues no label and no notification, and marks the Thread pending", () => {
    const w = world();
    try {
      w.escalate();
      const t = w.ledger.getThread(4)!;
      expect(t.phase).toMatchObject({ kind: "needs_you", code: "review_vetoed" });
      expect(t.factoryTriage).toBe("pending");
      expect(outbox(w.ledger)).toEqual([]);
    } finally {
      w.cleanup();
    }
  });

  it.each([
    ["the knob is off", { knob: "off" as const }],
    ["the code is not eligible", {}],
  ])("does not hold when %s", (_n, o) => {
    const w = world(o);
    try {
      w.escalate(_n === "the code is not eligible" ? "merge_conflict" : "review_vetoed");
      expect(w.ledger.getThread(4)!.factoryTriage).toBeNull();
      expect(outbox(w.ledger)).toEqual(["add_label", "notify_needs_you"]);
    } finally {
      w.cleanup();
    }
  });

});

describe("triage outcomes", () => {
  it("guidance spends the single factory retry, resumes without a notification, and starts one factory Attempt with the note", async () => {
    const w = world();
    try {
      w.review("openai", "veto");
      w.review("anthropic", "approve");
      w.escalate();
      await w.triage();
      expect(w.invoker.mock.calls[0]![0]).toMatchObject({ provider: "codex" }); // a vendor that vetoed, never the implementer's (anthropic)
      const t = w.ledger.getThread(4)!;
      expect(t.phase.kind).toBe("awaiting_gate");
      expect(t.factoryTriage).toBe("done");
      expect(t.factoryRetries).toBe(1);
      expect(t.retryGrants).toBe(0); // no budget granted
      expect(t.ownerReply).toBeNull();
      expect(t.factoryGuidance).toContain("Narrow it.");
      expect(outbox(w.ledger)).toEqual([]);
      expect(w.spawn).toHaveBeenCalledTimes(1);
      expect(w.spawn.mock.calls[0]![2]).toBe("revise");
      expect(w.spawn.mock.calls[0]![8]).toBe(true);
      expect(w.ledger.listAudit({ topicPrefix: "factory/" }).map((a) => `${a.topic}:${a.actor}`)).toEqual(expect.arrayContaining(["factory/triage:factory", "factory/retry:factory"]));
    } finally {
      w.cleanup();
    }
  });

  it("'the veto is wrong' can only escalate: veto_disputed never retries, even when decision says guidance", async () => {
    const w = world({ invoker: async () => ({ ...GOOD, cause: "veto_disputed", escalateReason: "I think the veto is mistaken" }) });
    try {
      w.review("openai", "veto");
      w.escalate();
      await w.triage();
      expect(w.spawn).not.toHaveBeenCalled();
      expect(w.ledger.getThread(4)).toMatchObject({ factoryRetries: 0, factoryTriage: "done" });
      expect(outbox(w.ledger)).toEqual(["add_label", "notify_needs_you"]);
      expect(w.ledger.listAudit({ topicPrefix: "thread/merged" })).toHaveLength(0);
    } finally {
      w.cleanup();
    }
  });

});

describe("auto-off", () => {
  const retried = (l: Ledger, n: number, code: string, phase: object, ownerActed = false) => {
    l.upsertThread({ issueNumber: n, title: "t", bodySha256: "x", phase: phase as never });
    l.appendAudit("factory/retry", n, "factory", { code });
    if (ownerActed) l.appendAudit("thread/owner_reply", n, "owner", {});
  };

  it("three of the last five unmerged switch the repo off with exactly one Needs You, and held escalations stop", async () => {
    const w = world();
    try {
      const wf = (w.rec as unknown as Priv).workflow;
      retried(w.ledger, 21, "review_vetoed", { kind: "done", outcome: "merged" });
      for (const n of [22, 23, 24]) retried(w.ledger, n, "review_vetoed", { kind: "done", outcome: "pr_closed" }, true);
      await (w.rec as unknown as Priv).checkFactoryAutoOff(wf, Date.now());
      await (w.rec as unknown as Priv).checkFactoryAutoOff(wf, Date.now());
      expect(w.notes.filter((n) => n.includes("factory retry switched off"))).toHaveLength(1);
      w.escalate();
      expect(w.ledger.getThread(4)!.factoryTriage).toBeNull(); // not held: factory retry is off
      expect(outbox(w.ledger)).toEqual(["add_label", "notify_needs_you"]);
    } finally {
      w.cleanup();
    }
  });

});
