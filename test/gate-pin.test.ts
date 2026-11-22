import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUMP_BRANCH, assessPinDrift, gateBump, latestGateCommit, pinOf, withPin } from "../src/core/gate-pin.js";
import { execRunner, type OnboardRunner } from "../src/core/onboard.js";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();

const TEMPLATE = "env:\n  ARCHANGEL_GATE_SHA: REPLACE\nsteps: [gate]\n";

/** Temp "Archangel" checkout: c1 (gate) -> c2 (docs only) -> c3 (gate). origin/main = HEAD. */
function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gatepin-"));
  git(root, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(root, "workflows"));
  fs.mkdirSync(path.join(root, "src/gate"), { recursive: true });
  fs.writeFileSync(path.join(root, "workflows/archangel-gate.yml"), TEMPLATE);
  fs.writeFileSync(path.join(root, "src/gate/g.ts"), "1");
  git(root, "add", "-A"); git(root, "commit", "-qm", "c1");
  const c1 = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "README.md"), "x");
  git(root, "add", "-A"); git(root, "commit", "-qm", "c2");
  const c2 = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "src/gate/g.ts"), "2");
  git(root, "add", "-A"); git(root, "commit", "-qm", "c3");
  const c3 = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", c3);
  return { root, c1, c2, c3 };
}

/** Real git for local reads, scripted gh, "git fetch" and "git status" stubbed so no remote is needed. */
function runnerFor(root: string, o: { wf?: string | null; openPr?: string; dirty?: boolean; offMain?: boolean }) {
  const calls: string[] = [];
  const runner: OnboardRunner = {
    async run(cmd, args, opts) {
      const line = `${cmd} ${args.join(" ")}`;
      calls.push(line);
      if (cmd === "git") {
        if (args[0] === "fetch") return "";
        if (args[0] === "status") return o.dirty ? " M x\n" : "";
        if (o.offMain && args[0] === "merge-base" && args.includes("origin/main")) throw new Error("not ancestor");
        return execRunner.run(cmd, args, opts);
      }
      if (line.startsWith("gh repo view")) return "main\n";
      if (line.includes("contents/.github/workflows/archangel-gate.yml?ref=")) {
        if (o.wf === null) throw new Error("404");
        return `blobsha\t${Buffer.from(o.wf ?? "").toString("base64")}\n`;
      }
      if (line.startsWith("gh pr list")) return o.openPr ?? "";
      if (line.includes("/git/ref/heads/")) return "basesha\n";
      if (line.startsWith("gh pr create")) return "https://github.com/o/r/pull/9\n";
      return "";
    },
  };
  return { runner, calls, mutating: () => calls.filter((c) => /-X POST|-X PUT|pr create/.test(c)) };
}

describe("pin helpers", () => {
  it("reads and rewrites only the pin line", () => {
    expect(pinOf(TEMPLATE)).toBe("REPLACE");
    expect(withPin(TEMPLATE, "abc")).toBe("env:\n  ARCHANGEL_GATE_SHA: abc\nsteps: [gate]\n");
    expect(pinOf("no pin")).toBeNull();
  });
});

describe("drift detection", () => {
  it("uses the latest commit touching gate paths, not docs-only commits", async () => {
    const { root, c3 } = checkout();
    expect(await latestGateCommit(execRunner, root)).toBe(c3);
  });

  it("flags an older pin, accepts the latest or newer, flags an unknown pin", async () => {
    const { root, c1, c2, c3 } = checkout();
    const wf = (sha: string) => withPin(TEMPLATE, sha);
    const a = (sha: string) => assessPinDrift(execRunner, wf(sha), c3, { root, template: TEMPLATE });
    expect((await a(c1)).reasons[0]).toContain("older than the latest gate-relevant commit");
    expect((await a(c2)).drifted).toBe(true);
    expect((await a(c3)).drifted).toBe(false);
    expect((await a("f".repeat(40))).reasons[0]).toContain("not in the local Archangel checkout");
    // a pin newer than the latest gate commit (e.g. a later docs commit) is fine
    expect((await assessPinDrift(execRunner, wf(c3), c1, { root, template: TEMPLATE })).drifted).toBe(false);
  });

  it("ignores the pin when diffing the template but flags any other difference or a missing pin", async () => {
    const { root, c3 } = checkout();
    const same = await assessPinDrift(execRunner, withPin(TEMPLATE, c3), c3, { root, template: TEMPLATE });
    expect(same.drifted).toBe(false);
    const edited = await assessPinDrift(execRunner, withPin(TEMPLATE, c3).replace("[gate]", "[evil]"), c3, { root, template: TEMPLATE });
    expect(edited.reasons).toEqual(["workflow differs from the canonical template (ignoring the pin)"]);
    const nopin = await assessPinDrift(execRunner, "steps: [gate]\n", c3, { root, template: TEMPLATE });
    expect(nopin.reasons[0]).toContain("no ARCHANGEL_GATE_SHA");
  });
});

describe("gateBump", () => {
  const quiet = { log: () => {} };

  it("opens one PR for a drifted repo: canonical template pinned to HEAD, never merging", async () => {
    const { root, c1, c3 } = checkout();
    const { runner, calls } = runnerFor(root, { wf: withPin(TEMPLATE, c1) });
    const res = await gateBump(runner, ["o/r"], { ...quiet, root });
    expect(res["o/r"]).toBe("bumped");
    const put = calls.find((c) => c.includes("-X PUT"))!;
    expect(put).toContain("sha=blobsha");
    expect(put).toContain(`branch=${BUMP_BRANCH}`);
    const content = /content=(\S+)/.exec(put)![1]!;
    expect(Buffer.from(content, "base64").toString()).toBe(withPin(TEMPLATE, c3));
    expect(calls.some((c) => /pr merge/.test(c))).toBe(false);
  });

  it("does nothing for a current repo, a repo without the workflow, or one with an open bump PR", async () => {
    const { root, c1, c3 } = checkout();
    const cur = runnerFor(root, { wf: withPin(TEMPLATE, c3) });
    expect((await gateBump(cur.runner, ["o/r"], { ...quiet, root }))["o/r"]).toBe("current");
    expect(cur.mutating()).toEqual([]);
    const none = runnerFor(root, { wf: null });
    expect((await gateBump(none.runner, ["o/r"], { ...quiet, root }))["o/r"]).toBe("no-workflow");
    const open = runnerFor(root, { wf: withPin(TEMPLATE, c1), openPr: "https://github.com/o/r/pull/3" });
    expect((await gateBump(open.runner, ["o/r"], { ...quiet, root }))["o/r"]).toBe("pr-open");
    expect(open.mutating()).toEqual([]);
  });

  it("dry-run reports drift and makes no mutating calls", async () => {
    const { root, c1 } = checkout();
    const { runner, mutating } = runnerFor(root, { wf: withPin(TEMPLATE, c1) });
    const res = await gateBump(runner, ["o/r"], { ...quiet, root, dryRun: true });
    expect(res["o/r"]).toBe("would-bump");
    expect(mutating()).toEqual([]);
  });

  it("refuses on a dirty checkout, when HEAD is not on origin/main, and for a bad repo name", async () => {
    const { root, c1 } = checkout();
    const wf = withPin(TEMPLATE, c1);
    await expect(gateBump(runnerFor(root, { wf, dirty: true }).runner, ["o/r"], { ...quiet, root })).rejects.toThrow(/uncommitted/);
    await expect(gateBump(runnerFor(root, { wf, offMain: true }).runner, ["o/r"], { ...quiet, root })).rejects.toThrow(/not on origin\/main/);
    await expect(gateBump(runnerFor(root, { wf }).runner, ["nope"], { ...quiet, root })).rejects.toThrow(/owner\/name/);
  });
});
