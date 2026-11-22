import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const commands: string[] = [];
const outcomes = new Map<string, "missing" | "unauthenticated">();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = Object.assign(() => undefined, {
    [Symbol.for("nodejs.util.promisify.custom")]: async (file: string, args: string[]) => {
      commands.push(`${file} ${args.join(" ")}`);
      if (outcomes.has(file) && outcomes.get(file) === "missing") throw new Error("ENOENT");
      const loggedIn = file === "claude" ? '{"loggedIn": true}' : "Logged in";
      const loggedOut = file === "claude" ? '{"loggedIn": false}' : "Not logged in";
      let stdout = args[0] === "--version" ? `${file} 1.0.0` : loggedIn;
      if (outcomes.get(file) === "unauthenticated" && args[0] !== "--version") stdout = loggedOut;
      return { stdout, stderr: "" };
    },
  });
  return {
    ...actual,
    execFile,
  };
});

import { runDoctor } from "../src/core/doctor.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  outcomes.clear();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-smoke-"));
  tempDirs.push(dir);
  const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs1", format: "pem" }).toString();
  const configPath = path.join(dir, "archangel.yaml");
  fs.writeFileSync(configPath, `ownerUserId: 999\nauthMode: subscription\ndataDir: ${dir}/data\nchains:\n  implement:\n    - provider: codex\n    - provider: agy\nreviewerChain:\n  - provider: claude\n  - provider: codex\nprojects:\n  - repo: acme/app\n`);
  const env = { ARCHANGEL_GITHUB_APP_ID: "123", ARCHANGEL_GITHUB_INSTALLATION_ID: "456", ARCHANGEL_GITHUB_PRIVATE_KEY_PEM: key };
  return { configPath, env };
}

describe("archangel doctor --smoke", () => {
  it("checks every unique configured subscription CLI for version and authentication", async () => {
    commands.length = 0;
    const { configPath, env } = setup();
    const report = await runDoctor({ configPath, env, offline: true, smoke: true });
    expect(report.checks.filter((c) => c.id.startsWith("smoke_provider:")).map((c) => c.id).sort())
      .toEqual(["smoke_provider:agy", "smoke_provider:claude", "smoke_provider:codex"]);
    expect(report.checks.filter((c) => c.id.startsWith("smoke_provider:")).every((c) => c.status === "pass")).toBe(true);
    for (const p of ["codex", "agy", "claude"]) {
      expect(commands).toContain(`${p} --version`);
    }
    expect(commands).toContain("codex login status");
    expect(commands).toContain("claude auth status");
    expect(commands.some((c) => c.startsWith("agy auth"))).toBe(false);
  });

  it("fails the affected provider with actionable remediation when missing or unauthenticated", async () => {
    const { configPath, env } = setup();
    outcomes.set("agy", "missing");
    const report = await runDoctor({ configPath, env, offline: true, smoke: true });
    const missing = report.checks.find((c) => c.id === "smoke_provider:agy");
    expect(missing?.status).toBe("fail");
    expect(missing?.remediation).toMatch(/install|PATH/i);

    outcomes.clear();
    outcomes.set("claude", "unauthenticated");
    const unauthenticated = await runDoctor({ configPath, env, offline: true, smoke: true });
    const claude = unauthenticated.checks.find((c) => c.id === "smoke_provider:claude");
    expect(claude?.status).toBe("fail");
    expect(claude?.remediation).toMatch(/claude/i);

    outcomes.clear();
    outcomes.set("codex", "unauthenticated");
    const codex = (await runDoctor({ configPath, env, offline: true, smoke: true })).checks.find(
      (c) => c.id === "smoke_provider:codex",
    );
    expect(codex?.status).toBe("fail");
    expect(codex?.remediation).toMatch(/codex login/);
  });
});
