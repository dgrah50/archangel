import { spawnSync } from "node:child_process";

/**
 * Whether this process can start a macOS sandbox. False off macOS, and false inside a sandbox: macOS cannot nest them, so a
 * sandboxed agent running this suite skips the tests that start one instead of failing them.
 */
export const canSandbox = process.platform === "darwin" && spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
