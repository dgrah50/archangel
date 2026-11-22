import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "bun:test";
import { isProtectedPath, isTestOrFixtureFile } from "../src/gate/gate.js";

// Allowlist, not blocklist: every tracked src/ file must be protected unless the owner explicitly
// lists it as a self-improvable leaf in .agents/leaf-modules.json (itself under protected .agents/).
describe("Archangel's own protected paths", () => {
  const workflow = JSON.parse(fs.readFileSync(".agents/archangel.json", "utf8")) as { gate: { protectedPaths: string[] } };
  const leaves = new Set((JSON.parse(fs.readFileSync(".agents/leaf-modules.json", "utf8")) as { files: string[] }).files);
  const protectedPaths = workflow.gate.protectedPaths;
  const tracked = execFileSync("git", ["ls-files", "src"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);

  it("protects every src file that is not an owner-listed leaf", () => {
    const unclassified = tracked.filter((f) => !leaves.has(f) && !isProtectedPath(f, protectedPaths));
    expect(unclassified).toEqual([]);
  });

  it("makes every existing test helper immutable, so a factory PR cannot weaken tests by editing the fakes they run against", () => {
    const g = (JSON.parse(fs.readFileSync(".agents/archangel.json", "utf8")) as { gate: { testFileGlobs: string[]; testDataGlobs?: string[] } }).gate;
    const policy = { testFileGlobs: g.testFileGlobs, testDataGlobs: g.testDataGlobs ?? [] };
    const helpers = execFileSync("git", ["ls-files", "test/helpers"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    expect(helpers.length).toBeGreaterThan(0);
    for (const f of helpers) expect(isTestOrFixtureFile(f, policy), f).toBe(true);
  });

});

describe("Gate pin drift covers the whole Gate bundle", () => {
  it("lists every src file the bundled Gate imports in GATE_RELEVANT_PATHS", async () => {
    const { build } = await import("esbuild");
    const { GATE_RELEVANT_PATHS } = await import("../src/core/gate-pin.js");
    const res = await build({
      entryPoints: ["src/gate/cli.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(res.metafile.inputs).filter((f) => f.startsWith("src/"));
    const uncovered = inputs.filter((f) => !GATE_RELEVANT_PATHS.some((p) => f === p || f.startsWith(`${p}/`)));
    expect(uncovered).toEqual([]);
  });
});
