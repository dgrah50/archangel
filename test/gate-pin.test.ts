import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { BUMP_BRANCH, assessPinDrift, gateBump, withPin } from "../src/core/gate-pin.js";
import { withBranch } from "../src/core/onboard.js";
import { execRunner, type OnboardRunner } from "../src/core/onboard.js";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" }).trim();

const TEMPLATE = "on:\n  pull_request:\n    branches: [main]\nenv:\n  ARCHANGEL_GATE_SHA: REPLACE\nsteps: [gate]\n";

/** Temp "Archangel" checkout: c1 (gate) -> c2 (docs only) -> c3 (gate). origin/main = HEAD. */
function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gatepin-"));
  git(root, "init", "-q", "-b", "main");
  fs.mkdirSync(path.join(root, "workflows"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "workflows/archangel-gate.yml"), TEMPLATE);
  fs.writeFileSync(path.join(root, "bin/archangel-gate.mjs"), "1");
  git(root, "add", "-A"); git(root, "commit", "-qm", "c1");
  const c1 = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "README.md"), "x");
  git(root, "add", "-A"); git(root, "commit", "-qm", "c2");
  const c2 = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "bin/archangel-gate.mjs"), "2");
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
        if (o.offMain && args[0] === "merge-base" && args.includes("origin/main")) throw Object.assign(new Error("not ancestor"), { code: 1 });
        return execRunner.run(cmd, args, opts);
      }
      if (line.startsWith("gh repo view")) return "main\n";
      if (line.includes("contents/.github/workflows/archangel-gate.yml?ref=")) {
        if (o.wf === null) throw new Error("404");
        return args.includes("--jq") ? "blobsha\n" : (o.wf ?? "");
      }
      if (line.startsWith("gh pr list")) return o.openPr ?? "";
      if (/git\/ref\/heads\/chore\//.test(line)) throw new Error("HTTP 404");
      if (line.includes("/git/ref/heads/")) return "basesha\n";
      if (line.startsWith("gh pr create")) return "https://github.com/o/r/pull/9\n";
      return "";
    },
  };
  return { runner, calls, mutating: () => calls.filter((c) => /-X POST|-X PUT|pr create/.test(c)) };
}

describe("drift detection", () => {
  it("a changed Gate bundle is a newer bundle, not drift; an unchanged one is current; an unknown pin is drift", async () => {
    const { root, c1, c2, c3 } = checkout();
    const wf = (sha: string) => withPin(TEMPLATE, sha);
    const a = (sha: string) => assessPinDrift(execRunner, wf(sha), { root, template: TEMPLATE });
    expect(await a(c1)).toMatchObject({ drifted: false, newerBundle: true });
    // c2 only touched docs: its bundle is the one c1 pinned, still older than HEAD's
    expect(await a(c2)).toMatchObject({ drifted: false, newerBundle: true });
    expect(await a(c3)).toMatchObject({ drifted: false, newerBundle: false });
    expect((await a("f".repeat(40))).reasons[0]).toContain("not in the local Archangel checkout");
    // the template's branch is the repo's own: a trunk workflow is current on trunk, and a `main` one is drift there
    const trunk = { root, template: TEMPLATE, branch: "trunk" };
    expect((await assessPinDrift(execRunner, withBranch(wf(c3), "trunk"), trunk)).drifted).toBe(false);
    expect((await assessPinDrift(execRunner, wf(c3), trunk)).drifted).toBe(true);
  });

  it("a docs-only commit after the pin leaves the pin current", async () => {
    const { root, c3 } = checkout();
    fs.writeFileSync(path.join(root, "README.md"), "y");
    git(root, "add", "-A"); git(root, "commit", "-qm", "c4");
    expect(await assessPinDrift(execRunner, withPin(TEMPLATE, c3), { root, template: TEMPLATE })).toMatchObject({ drifted: false, newerBundle: false });
  });

  it("flags a pin on a divergent line that is not in main's history", async () => {
    const { root, c1 } = checkout();
    git(root, "checkout", "-q", "-b", "side", c1);
    fs.writeFileSync(path.join(root, "bin/archangel-gate.mjs"), "weakened");
    git(root, "add", "-A"); git(root, "commit", "-qm", "side");
    const side = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "main");
    const res = await assessPinDrift(execRunner, withPin(TEMPLATE, side), { root, template: TEMPLATE });
    expect(res.drifted).toBe(true);
    expect(res.reasons[0]).toContain("divergent history");
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
    expect(Buffer.from(content, "base64").toString()).toBe(withBranch(withPin(TEMPLATE, c3), "main"));
    expect(calls.some((c) => /pr merge/.test(c))).toBe(false);
  });

  it("refuses on a dirty checkout, when HEAD is not on origin/main, and for a bad repo name", async () => {
    const { root, c1 } = checkout();
    const wf = withPin(TEMPLATE, c1);
    await expect(gateBump(runnerFor(root, { wf, dirty: true }).runner, ["o/r"], { ...quiet, root })).rejects.toThrow(/uncommitted/);
    await expect(gateBump(runnerFor(root, { wf, offMain: true }).runner, ["o/r"], { ...quiet, root })).rejects.toThrow(/not on origin\/main/);
    await expect(gateBump(runnerFor(root, { wf }).runner, ["nope"], { ...quiet, root })).rejects.toThrow(/owner\/name/);
  });
});
