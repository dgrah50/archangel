import { afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Preloaded by `bun test` (bunfig.toml). Every test process gets its own temp root, emptied after each test file and removed with
 * the last one, so a test that makes a temp dir and never deletes it leaves nothing behind. (A full run used to leave several
 * hundred directories in the system temp dir.) `os.tmpdir()` reads TMPDIR on each call, so tests and the code under test both
 * land inside the root.
 */
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "archangel-test-"));
process.env.TMPDIR = root;

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
