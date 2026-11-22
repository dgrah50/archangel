import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, spyOn } from "bun:test";
import { GitBroker } from "../src/broker/git-broker.js";
import { ConfigSchema } from "../src/config.js";
import { Reconciler } from "../src/core/reconciler.js";
import { buildDigest } from "../src/core/digest.js";
import { computeHealth, renderHealth } from "../src/core/status-text.js";
import { buildUiState } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";
import { goWorkflowJson } from "./helpers/workflow.js";
import { noCli } from "./helpers/no-cli.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-health-"));
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
  const github = new FakeGitHub(path.join(root, "remote.git"));
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  const cfg = ConfigSchema.parse({ githubOwner: "acme", githubRepo: "app", ownerUserId: 999, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "fake" });
  const warnings: string[] = [];
  const notices: unknown[] = [];
  const rec = new Reconciler({ triageInvoker: noCli,
    config: cfg, ledger, github,
    broker: new GitBroker({ bareRepoPath: path.join(root, "broker.git"), clonesDir: path.join(root, "clones") }),
    implementer: { async run() { throw new Error("unused"); } },
    reviewers: { async reviewAll() { return { results: [], errors: [] }; } },
    notifier: { async notifyNeedsYou(n: unknown) { notices.push(n); }, async sendDigest() {} },
    logger: { info() {}, warn: (e: string, m: string) => void warnings.push(`${e}: ${m}`), error() {} } as never,
  });
  return { root, github, ledger, rec, warnings, notices };
}


describe("survived errors become explicit health facts", () => {
  it("counts an intake error class, shows it in Health, and raises one Needs You per class per day at 3", async () => {
    const w = await world();
    try {
      w.github.issues.set(5, { number: 5, title: "t", body: "b", state: "open", authorId: 999, authorLogin: "o", authorAssociation: "OWNER", labels: ["ready-for-agent"], updatedAt: "" });
      spyOn(w.rec as unknown as { reconcileIntakeIssue: () => Promise<void> }, "reconcileIntakeIssue").mockRejectedValue(new Error("intake boom"));
      const t0 = Date.now();
      await w.rec.tick(t0, { waitForAttempts: true });
      await w.rec.tick(t0 + 1000, { waitForAttempts: true });
      expect(w.notices).toHaveLength(0);
      await w.rec.tick(t0 + 2000, { waitForAttempts: true });
      expect(w.notices).toHaveLength(1);
      await w.rec.tick(t0 + 3000, { waitForAttempts: true });
      expect(w.notices).toHaveLength(1); // once per class per day

      const faults = w.ledger.listHealthFaults(t0 + 3000);
      expect(faults).toHaveLength(1);
      expect(faults[0]).toMatchObject({ repo: "acme/app", category: "intake", count: 4, recent24h: 4, firstSeen: t0, lastSeen: t0 + 3000 });
      const health = computeHealth(w.ledger, t0 + 3000, ["acme/app"]);
      expect(health.ok).toBe(false);
      expect(renderHealth(health).join("\n")).toMatch(/! Errors:.*intake x4.*intake boom/);
      expect(buildUiState(w.ledger, t0 + 3000).faults).toHaveLength(1);
      expect(buildDigest(w.ledger.collectDigestInput(t0 + 3000))).toContain("acme/app intake x4");

      // a day later the class is stale and no longer shown
      expect(w.ledger.listHealthFaults(t0 + 2 * 86_400_000)).toHaveLength(0);
    } finally {
      w.ledger.close();
      fs.rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
