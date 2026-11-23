import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { runDoctor } from "../src/core/doctor.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeExecutable(dir: string, name: string, script: string): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

function makeFakeBinDir(dir: string): string {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  writeExecutable(
    binDir,
    "claude",
    `if [ "$1" = "--version" ]; then echo "claude 1.0.0"; exit 0; fi
echo "claude:$CLAUDE_CONFIG_DIR" >> "${dir}/invocations.log"
if [ -f "$CLAUDE_CONFIG_DIR/logged_out" ]; then echo '{"loggedIn": false}'; else echo '{"loggedIn": true}'; fi`,
  );

  writeExecutable(
    binDir,
    "codex",
    `if [ "$1" = "--version" ]; then echo "codex 1.0.0"; exit 0; fi
echo "codex:$CODEX_HOME" >> "${dir}/invocations.log"
if [ -f "$CODEX_HOME/logged_out" ]; then echo "Not logged in"; else echo "Logged in"; fi`,
  );

  writeExecutable(
    binDir,
    "agy",
    `echo "agy:$HOME" >> "${dir}/invocations.log"
echo "agy 1.0.0"`,
  );

  return binDir;
}

describe("archangel doctor --smoke (real subprocesses, per-account env isolation)", () => {
  it("runs real provider CLIs with isolated account homes and fails only logged-out or missing providers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-e2e-"));
    tempDirs.push(dir);
    const binDir = makeFakeBinDir(dir);

    for (const h of ["claude-a", "claude-b", "codex-a", "agy-a"]) {
      fs.mkdirSync(path.join(dir, h), { recursive: true });
      fs.writeFileSync(path.join(dir, h, "login"), "ok");
    }
    fs.writeFileSync(path.join(dir, "claude-b", "logged_out"), "1");

    const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      .export({ type: "pkcs1", format: "pem" }).toString();
    const configPath = path.join(dir, "archangel.yaml");
    fs.writeFileSync(
      configPath,
      [
        "ownerUserId: 999",
        `dataDir: ${dir}/data`,
        "accounts:",
        `  - { id: claude-a, provider: claude, home: ${dir}/claude-a }`,
        `  - { id: claude-b, provider: claude, home: ${dir}/claude-b }`,
        `  - { id: codex-a, provider: codex, home: ${dir}/codex-a }`,
        `  - { id: agy-a, provider: agy, home: ${dir}/agy-a }`,
        "projects:",
        "  - repo: acme/app",
      ].join("\n"),
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ARCHANGEL_GITHUB_APP_ID: "123",
      ARCHANGEL_GITHUB_INSTALLATION_ID: "456",
      ARCHANGEL_GITHUB_PRIVATE_KEY_PEM: key,
    };

    const report = await runDoctor({ configPath, env, offline: true, smoke: true });
    const smoke = report.checks.filter((c) => c.id.startsWith("smoke_provider:"));
    expect(smoke.map((c) => [c.id, c.status]).sort()).toEqual([
      ["smoke_provider:agy-a", "pass"],
      ["smoke_provider:claude-a", "pass"],
      ["smoke_provider:claude-b", "fail"],
      ["smoke_provider:codex-a", "pass"],
    ]);
    const failed = smoke.find((c) => c.id === "smoke_provider:claude-b")!;
    expect(failed.remediation).toContain(`CLAUDE_CONFIG_DIR=${dir}/claude-b`);

    const logLines = fs.readFileSync(path.join(dir, "invocations.log"), "utf8").trim().split("\n");
    expect(logLines).toEqual(
      expect.arrayContaining([
        `claude:${dir}/claude-a`,
        `claude:${dir}/claude-b`,
        `codex:${dir}/codex-a`,
        `agy:${dir}/agy-a`,
      ]),
    );
  });
});
