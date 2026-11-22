import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDataDir } from "../src/cli/data-dir.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "archangel-datadir-"));
}

describe("resolveDataDir", () => {
  it("prefers --data-dir, then the host config's dataDir, then ARCHANGEL_DATA_DIR / the default", () => {
    const dir = tmp();
    try {
      const cfg = path.join(dir, "archangel.yaml");
      fs.writeFileSync(cfg, `ownerUserId: 1\ndataDir: ${dir}/custom\nprojects:\n  - repo: a/b\n`);
      expect(resolveDataDir({ dataDir: "/x" }, {})).toBe("/x");
      expect(resolveDataDir({ config: cfg }, {})).toBe(`${dir}/custom`);
      expect(resolveDataDir({}, { ARCHANGEL_CONFIG: cfg })).toBe(`${dir}/custom`);
      expect(resolveDataDir({}, { ARCHANGEL_DATA_DIR: "/env", ARCHANGEL_CONFIG: path.join(dir, "missing.yaml") })).toBe("/env");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly on an invalid host config instead of opening the default Ledger", () => {
    const dir = tmp();
    try {
      const cfg = path.join(dir, "archangel.yaml");
      fs.writeFileSync(cfg, `ownerUserId: 1\ndataDir: ${dir}/custom\nmaxSomethingRemoved: 3\nprojects:\n  - repo: a/b\n`);
      expect(() => resolveDataDir({ config: cfg }, {})).toThrow();
      expect(() => resolveDataDir({ config: path.join(dir, "nope.yaml") }, {})).toThrow(/ENOENT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
