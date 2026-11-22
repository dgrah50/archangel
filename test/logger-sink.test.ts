import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchangelLogger } from "../src/core/logger.js";

describe("the JSONL log sink does not fail silently", () => {
  afterEach(() => vi.restoreAllMocks());
  it("warns on stderr when a write fails, at most once a minute, and never throws", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-log-"));
    const logger = new ArchangelLogger({ logFilePath: path.join(dir, "a.jsonl"), consoleOutput: false });
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logger.info("x", "one");
    logger.info("x", "two");
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain("ENOSPC");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
