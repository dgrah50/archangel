import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
const loggedOutHomes = new Set<string>();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = Object.assign(() => undefined, {
    [Symbol.for("nodejs.util.promisify.custom")]: async (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      const env = opts?.env ?? {};
      calls.push({ file, args, env });
      if (args[0] === "--version") return { stdout: `${file} 1.0.0`, stderr: "" };
      const home = env.CLAUDE_CONFIG_DIR ?? env.CODEX_HOME ?? "";
      const out = loggedOutHomes.has(home) ? "Not logged in" : file === "claude" ? '{"loggedIn": true}' : "Logged in";
      return { stdout: file === "claude" && loggedOutHomes.has(home) ? '{"loggedIn": false}' : out, stderr: "" };
    },
  });
  return { ...actual, execFile };
});

import { runDoctor } from "../src/core/doctor.js";

const dirs: string[] = [];
afterEach(() => {
  calls.length = 0;
  loggedOutHomes.clear();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(accountsYaml: string, makeHomes: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-accts-"));
  dirs.push(dir);
  for (const h of makeHomes) {
    fs.mkdirSync(path.join(dir, h), { recursive: true });
    fs.writeFileSync(path.join(dir, h, "login"), "x");
  }
  const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const configPath = path.join(dir, "archangel.yaml");
  fs.writeFileSync(configPath, `ownerUserId: 999\nauthMode: subscription\ndataDir: ${dir}/data\n${accountsYaml.replaceAll("$DIR", dir)}\nprojects:\n  - repo: acme/app\n`);
  return { dir, configPath, env: { ARCHANGEL_GITHUB_APP_ID: "123", ARCHANGEL_GITHUB_INSTALLATION_ID: "456", ARCHANGEL_GITHUB_PRIVATE_KEY_PEM: key } };
}

const TWO_EACH = `accounts:
  - { id: claude-a, provider: claude, home: $DIR/claude-a }
  - { id: claude-b, provider: claude, home: $DIR/claude-b }
  - { id: codex-a, provider: codex, home: $DIR/codex-a }
  - { id: codex-b, provider: codex, home: $DIR/codex-b }
  - { id: agy-a, provider: agy, home: $DIR/agy-a }
  - { id: agy-b, provider: agy, home: $DIR/agy-b }`;
const HOMES = ["claude-a", "claude-b", "codex-a", "codex-b", "agy-a", "agy-b"];

describe("doctor --smoke per account", () => {
  it("checks every account once, with that account's own home in the environment", async () => {
    const { configPath, env, dir } = setup(TWO_EACH, HOMES);
    const report = await runDoctor({ configPath, env, offline: true, smoke: true });
    const smoke = report.checks.filter((c) => c.id.startsWith("smoke_provider:"));
    expect(smoke.map((c) => c.id).sort()).toEqual(HOMES.map((h) => `smoke_provider:${h}`).sort());
    expect(smoke.every((c) => c.status === "pass")).toBe(true);
    const claudeStatus = calls.filter((c) => c.file === "claude" && c.args[0] === "auth").map((c) => c.env.CLAUDE_CONFIG_DIR);
    expect(claudeStatus.sort()).toEqual([path.join(dir, "claude-a"), path.join(dir, "claude-b")]);
    const codexStatus = calls.filter((c) => c.file === "codex" && c.args[0] === "login").map((c) => c.env.CODEX_HOME);
    expect(codexStatus).toContain(path.join(dir, "codex-b"));
    const agyHomes = calls.filter((c) => c.file === "agy").map((c) => c.env.HOME);
    expect(agyHomes).toContain(path.join(dir, "agy-a"));
  });

  it("fails only the account that is logged out, naming the account and its home", async () => {
    const { configPath, env, dir } = setup(TWO_EACH, HOMES);
    loggedOutHomes.add(path.join(dir, "claude-b"));
    const report = await runDoctor({ configPath, env, offline: true, smoke: true });
    const failed = report.checks.filter((c) => c.id.startsWith("smoke_provider:") && c.status === "fail");
    expect(failed.map((c) => c.id)).toEqual(["smoke_provider:claude-b"]);
    expect(failed[0]!.remediation).toContain(`CLAUDE_CONFIG_DIR=${dir}/claude-b`);
  });

  it("without an accounts list it checks one implicit account per provider, keyed by provider name, on the default home", async () => {
    const { configPath, env } = setup("");
    const report = await runDoctor({ configPath, env, offline: true, smoke: true });
    expect(report.checks.filter((c) => c.id.startsWith("smoke_provider:")).map((c) => c.id).sort()).toEqual([
      "smoke_provider:agy",
      "smoke_provider:claude",
      "smoke_provider:codex",
    ]);
    expect(calls.every((c) => c.env.CLAUDE_CONFIG_DIR === undefined || c.env.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR)).toBe(true);
  });

  it("warns explicitly that agy account separation via HOME is unverified when more than one agy account is configured", async () => {
    const { configPath, env } = setup(TWO_EACH, HOMES);
    const report = await runDoctor({ configPath, env, offline: true });
    const warn = report.checks.find((c) => c.id === "agy_accounts");
    expect(warn?.status).toBe("warn");
    expect(warn?.detail).toContain("agy account separation via HOME is unverified");
    const one = setup("accounts:\n  - { id: agy, provider: agy }\n  - { id: claude, provider: claude }\n  - { id: codex, provider: codex }");
    expect((await runDoctor({ configPath: one.configPath, env: one.env, offline: true })).checks.some((c) => c.id === "agy_accounts")).toBe(false);
  });
});
