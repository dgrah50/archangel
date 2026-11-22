import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUMP_BRANCH, assessPinDrift, gateBump, withPin } from "../src/core/gate-pin.js";
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

  it("flags a pin on a divergent line that is neither older nor newer than the latest gate commit", async () => {
    const { root, c1, c3 } = checkout();
    git(root, "checkout", "-q", "-b", "side", c1);
    fs.writeFileSync(path.join(root, "src/gate/g.ts"), "weakened");
    git(root, "add", "-A"); git(root, "commit", "-qm", "side");
    const side = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "main");
    const res = await assessPinDrift(execRunner, withPin(TEMPLATE, side), c3, { root, template: TEMPLATE });
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
    expect(Buffer.from(content, "base64").toString()).toBe(withPin(TEMPLATE, c3));
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
