import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { runSetupDryRun } from "../src/core/verify-setup.js";

describe("doctor --verify-setup", () => {
  it("reports a failing setup with a secret-scanned tail and leaves its HOME writes in a throwaway", async () => {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-vs-clone-"));
    const script = [
      `echo "$HOME" > "$PWD/home.txt"`,
      `touch "$HOME/leak"`,
      `echo ghp_${"a".repeat(30)}`,
      `echo boom`,
      `exit 3`,
    ].join("\n");
    try {
      const v = await runSetupDryRun({ script, cloneDir: clone, timeoutMs: 20_000, sandbox: null });
      expect(v.ok).toBe(false);
      expect(v.detail).toContain("exited 3");
      expect(v.detail).toContain("Withheld");
      expect(v.detail).not.toContain("ghp_");
      // The script's HOME was a throwaway that is gone, and the clone is the only place its own files landed.
      expect(fs.existsSync(fs.readFileSync(path.join(clone, "home.txt"), "utf8").trim())).toBe(false);
    } finally {
      fs.rmSync(clone, { recursive: true, force: true });
    }
  });
});
