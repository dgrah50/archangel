import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { type CommandState } from "../src/core/command-machine.js";
import { PaseoCliRunner, handoffThreadToPaseo, resumeThreadFromPaseo, type PaseoRunner } from "../src/handoff/paseo.js";
import { Ledger } from "../src/ledger/store.js";

const S: Record<string, CommandState> = {
  pending: { kind: "pending" },
  claimed: { kind: "claimed", at: 1 },
  completed: { kind: "completed", result: {} },
  failed: { kind: "failed", error: "x" },
  cancelled: { kind: "cancelled", reason: "x" },
};

describe("daemon command state machine", () => {
  it("the Ledger refuses and audits illegal moves, and a cancelled command can never be claimed", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const id = l.enqueueCommand(7, "handoff");
    expect(l.cancelCommand(id, "timeout")).toBe(true);
    expect(l.claimCommand(id)).toBe(false);
    expect(l.listPendingCommands()).toEqual([]);
    const id2 = l.enqueueCommand(7, "handoff");
    expect(l.claimCommand(id2)).toBe(true);
    expect(l.cancelCommand(id2, "timeout")).toBe(false);
    expect(l.completeCommand(id2, { ok: 1 })).toBe(true);
    expect(l.failCommand(id2, "late")).toBe(false);
    expect(l.getCommand(id2)!.state).toEqual({ kind: "completed", result: { ok: 1 } });
    expect(l.listAudit({ topicPrefix: "command/illegal_transition" })).toHaveLength(3);
    l.close();
  });
});

function setup(daemonWaitTimeoutMs: number) {
  const l = new Ledger(":memory:", { repo: "a/b" });
  l.upsertThread({ issueNumber: 7, title: "t", bodySha256: "x", phase: { kind: "awaiting_gate", prNumber: 5, headSha: "h", baseSha: "b", since: 1, nudgedAt: null } });
  const t = Date.now();
  expect(l.acquireDaemonLock("daemon-1", 60_000, t)).toBe(true); // a live daemon
  const launches: string[] = [];
  const paseo: PaseoRunner = {
    async checkoutBranchAndSeed(i) {
      launches.push(i.branchName);
      return { agentId: "ag1", workspaceId: null };
    },
    async isAgentRunning() {
      return false;
    },
  };
  const config = ConfigSchema.parse({ githubOwner: "a", githubRepo: "b", ownerUserId: 1, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "x" });
  const deps = { config, ledger: l, github: {} as never, broker: {} as never, paseo, daemonWaitTimeoutMs };
  return { l, deps, launches };
}

describe("handoff vs daemon claim race", () => {
  it("a CLI timeout cancels an unclaimed command: nothing changes and the daemon can never claim it later", async () => {
    const { l, deps, launches } = setup(300);
    await expect(handoffThreadToPaseo(7, deps)).rejects.toThrow(/claim the handoff; nothing was changed/);
    const cmd = l.listAudit({ topicPrefix: "command/" });
    expect(cmd).toEqual([]); // a clean cancel is not an illegal transition
    const id = 1;
    expect(l.getCommand(id)!.state.kind).toBe("cancelled");
    expect(l.claimCommand(id)).toBe(false); // the daemon arrives late: refused
    expect(l.getThread(7)!.phase.kind).toBe("awaiting_gate");
    expect(launches).toEqual([]);
    l.close();
  });

  it("if the daemon already claimed it, the CLI does not cancel and does not launch Paseo while the daemon is mid-handoff", async () => {
    const { l, deps, launches } = setup(300);
    const claimer = setTimeout(() => l.claimCommand(1), 100); // the daemon claims during the first wait
    await expect(handoffThreadToPaseo(7, deps)).rejects.toThrow(/claimed the handoff but did not finish it in time; Paseo was not launched/);
    clearTimeout(claimer);
    expect(l.getCommand(1)!.state.kind).toBe("claimed"); // still the daemon's
    expect(launches).toEqual([]);
    expect(l.completeCommand(1, { branchName: "factory/7", headSha: null })).toBe(true); // the daemon finishing is not overwritten by a CLI fail
    expect(l.getCommand(1)!.state.kind).toBe("completed");
    l.close();
  });

  it("completes normally when the daemon claims and finishes in time", async () => {
    const { l, deps, launches } = setup(2_000);
    const daemon = setTimeout(() => {
      expect(l.claimCommand(1)).toBe(true);
      const t = l.getThread(7)!;
      l.transition(7, t.version, { kind: "owner_driving", paseoAgentId: null, paseoWorkspaceId: null, since: Date.now(), prNumber: 5, headSha: "h", baseSha: "b" } as never, { nextMode: "advisory" });
      l.completeCommand(1, {});
    }, 100);
    const res = await handoffThreadToPaseo(7, deps);
    clearTimeout(daemon);
    expect(res.agentId).toBe("ag1");
    expect(launches).toEqual(["factory/7"]);
    l.close();
  });
});

describe("daemon liveness and Paseo state never fail open", () => {
  describe("isAgentRunning", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });
    const withPaseo = (script: string) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-fakepaseo-"));
      dirs.push(dir);
      fs.writeFileSync(path.join(dir, "paseo"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      const old = process.env.PATH;
      process.env.PATH = `${dir}:${old}`;
      return () => {
        process.env.PATH = old;
      };
    };

    it("is false only for a definite 'not found'; any other failure throws instead of reading as stopped", async () => {
      const restore1 = withPaseo('echo "Error: agent not found (HTTP 404)" >&2; exit 1');
      expect(await new PaseoCliRunner().isAgentRunning("ag")).toBe(false);
      restore1();
      const restore2 = withPaseo('echo "connect ECONNREFUSED 127.0.0.1:6767" >&2; exit 1');
      await expect(new PaseoCliRunner().isAgentRunning("ag")).rejects.toThrow(/Could not verify/);
      restore2();
      const restore3 = withPaseo("echo not-json");
      await expect(new PaseoCliRunner().isAgentRunning("ag")).rejects.toThrow(/unparseable/);
      restore3();
      const restore4 = withPaseo('echo \'{"status":"running"}\'');
      expect(await new PaseoCliRunner().isAgentRunning("ag")).toBe(true);
      restore4();
    });

    it("resume refuses when the agent's state cannot be verified, and leaves the Thread alone", async () => {
      const l = new Ledger(":memory:", { repo: "a/b" });
      l.upsertThread({
        issueNumber: 7, title: "t", bodySha256: "x",
        phase: { kind: "owner_driving", paseoAgentId: "ag1", paseoWorkspaceId: null, since: 1, prNumber: 5, headSha: "h", baseSha: "b" } as never,
        mode: "advisory",
      });
      const paseo: PaseoRunner = {
        async checkoutBranchAndSeed() {
          throw new Error("unused");
        },
        async isAgentRunning() {
          throw new Error("Could not verify whether Paseo agent ag1 is running: ECONNREFUSED");
        },
      };
      const config = ConfigSchema.parse({ githubOwner: "a", githubRepo: "b", ownerUserId: 1, githubAppId: "1", githubInstallationId: 2, githubPrivateKeyPem: "x" });
      await expect(resumeThreadFromPaseo(7, { config, ledger: l, github: {} as never, paseo })).rejects.toThrow(/Could not verify/);
      expect(l.getThread(7)!.phase.kind).toBe("owner_driving");
      l.close();
    });
  });
});
