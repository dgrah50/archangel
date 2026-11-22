import fs from "node:fs";
import { describe, expect, it } from "bun:test";
import { bump, type BumpCmd, type BumpRunner } from "../src/core/bump.js";
import { isProtectedPath } from "../src/gate/gate.js";

function fakeRunner(files: string[], over: { testFails?: boolean } = {}) {
  const calls: Array<{ cmd: BumpCmd; args: string[] }> = [];
  const runner: BumpRunner = {
    async run(cmd, args, opts) {
      calls.push({ cmd, args });
      if (cmd === "gh" && args[0] === "repo") {
        const dir = args[3]!;
        fs.mkdirSync(`${dir}/.agents`, { recursive: true });
        for (const f of files) fs.writeFileSync(`${dir}/${f}`, f === "package.json" ? '{"dependencies":{"ms":"^2.0.0"}}' : "");
        fs.writeFileSync(`${dir}/.agents/archangel.json`, JSON.stringify({ version: 1, gate: { testCmd: "bun test" } }));
        return "";
      }
      if (cmd === "git" && args[0] === "rev-parse") return "main\n";
      if (cmd === "git" && args[0] === "diff") return " bun.lock | 2 +-\n";
      if (cmd === "sh" && over.testFails) throw new Error("red");
      if (cmd === "gh" && args[0] === "pr") return "https://github.com/o/r/pull/1\n";
      return "";
    },
  };
  return { runner, calls };
}
const input = { repo: "o/r", level: "patch" as const, pkgs: [], yes: true, confirm: async () => true, log: () => {} };

describe("archangel bump", () => {
  it("never lets a lifecycle script run, and opens nothing when the repo's tests are red", async () => {
    for (const [lock, cmd] of [["bun.lock", "bun"], ["package-lock.json", "npm"]] as const) {
      const { runner, calls } = fakeRunner([lock, "package.json"]);
      expect(await bump(runner, input)).toBe("https://github.com/o/r/pull/1");
      const installs = calls.filter((c) => c.cmd === cmd && ["install", "ci", "update"].includes(c.args[0]!));
      expect(installs.length).toBe(2);
      for (const c of installs) expect(c.args).toContain("--ignore-scripts");
    }
    const red = fakeRunner(["bun.lock", "package.json"], { testFails: true });
    await expect(bump(red.runner, input)).rejects.toThrow("testCmd");
    expect(red.calls.some((c) => c.cmd === "git" && c.args[0] === "push")).toBe(false);
  });
});

describe("lockfiles stay blocked on factory/*", () => {
  it("protects the lockfiles and manifests of this repo", () => {
    const { protectedPaths } = (JSON.parse(fs.readFileSync(".agents/archangel.json", "utf8")) as { gate: { protectedPaths: string[] } }).gate;
    for (const f of ["bun.lock", "package.json"]) expect(isProtectedPath(f, protectedPaths), f).toBe(true);
  });
});
