import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfigs } from "../src/config.js";
import { loadDotEnv, parseDotEnv } from "../src/env.js";

describe("config security invariants", () => {
  it("loads .env without overriding existing process env and reads ARCHANGEL_GITHUB_PRIVATE_KEY_PATH", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-env-"));
    try {
      const pemPath = path.join(tmp, "app.pem");
      fs.writeFileSync(pemPath, "-----BEGIN RSA PRIVATE KEY-----\nTEST\n-----END RSA PRIVATE KEY-----\n");

      const envFile = path.join(tmp, ".env");
      fs.writeFileSync(
        envFile,
        `# comment\nARCHANGEL_GITHUB_APP_ID=99\nARCHANGEL_GITHUB_PRIVATE_KEY_PATH="${pemPath}"\nMULTILINE="a\\nb"\n`,
      );
      const targetEnv: NodeJS.ProcessEnv = { ARCHANGEL_GITHUB_APP_ID: "existing" };
      expect(loadDotEnv(envFile, targetEnv)).toBe(true);
      expect(targetEnv.ARCHANGEL_GITHUB_APP_ID).toBe("existing");
      expect(targetEnv.MULTILINE).toBe("a\nb");
      expect(parseDotEnv("export FOO='bar baz'").FOO).toBe("bar baz");

      const yamlPath = path.join(tmp, "archangel.yaml");
      fs.writeFileSync(
        yamlPath,
        `ownerUserId: 999\nprojects:\n  - repo: acme/app\n`,
      );
      const cfgs = loadProjectConfigs({
        configPath: yamlPath,
        env: { ...targetEnv, ARCHANGEL_GITHUB_INSTALLATION_ID: "1234" },
      });
      expect(cfgs[0]?.githubPrivateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("host limit and timeout knobs", () => {
  const env = {
    ARCHANGEL_GITHUB_APP_ID: "1",
    ARCHANGEL_GITHUB_PRIVATE_KEY_PEM: "pem",
    ARCHANGEL_GITHUB_INSTALLATION_ID: "2",
  };
  function load(yaml: string) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-knobs-"));
    try {
      const p = path.join(tmp, "archangel.yaml");
      fs.writeFileSync(p, yaml);
      return loadProjectConfigs({ configPath: p, env });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it("passes host knobs through, lets projects override attempt limits, and keeps defaults when omitted", () => {
    const [a, b] = load(
      [
        "ownerUserId: 9",
        "maxAutonomousStepsWithoutOwner: 7",
        "maxImplementAttemptsPerThread: 5",
        "maxRevisionsPerThread: 2",
        "maxRebasesPerThread: 3",
        "implementMaxTurns: 11",
        "implementTimeoutMs: 40000",
        "setupTimeoutMs: 6000",
        "staleLeaseMs: 20000",
        "gateStartGraceMs: 20000",
        "gateTimeoutMs: 120000",
        "reviewerOutageMaxMs: 120000",
        "projects:",
        "  - repo: acme/a",
        "  - repo: acme/b",
        "    maxImplementAttemptsPerThread: 1",
      ].join("\n"),
    ) as [ReturnType<typeof load>[number], ReturnType<typeof load>[number]];
    expect(a).toMatchObject({
      maxAutonomousStepsWithoutOwner: 7, maxImplementAttemptsPerThread: 5, maxRevisionsPerThread: 2,
      maxRebasesPerThread: 3, implementMaxTurns: 11, implementTimeoutMs: 40000, setupTimeoutMs: 6000,
      staleLeaseMs: 20000, gateStartGraceMs: 20000, gateTimeoutMs: 120000, reviewerOutageMaxMs: 120000,
    });
    expect(b.maxImplementAttemptsPerThread).toBe(1);
    expect(b.maxRevisionsPerThread).toBe(2);

    const [d] = load("ownerUserId: 9\nprojects:\n  - repo: acme/a\n");
    expect(d).toMatchObject({
      maxAutonomousStepsWithoutOwner: 25, maxImplementAttemptsPerThread: 3, maxRevisionsPerThread: 1,
      maxRebasesPerThread: 1, implementMaxTurns: 40, implementTimeoutMs: 1_200_000, setupTimeoutMs: 300_000,
      staleLeaseMs: 180_000, gateStartGraceMs: 300_000, gateTimeoutMs: 3_600_000, reviewerOutageMaxMs: 21_600_000,
    });
  });

  it.each([
    ["per-project gate", "    gate:\n      maxFiles: 3\n"],
    ["per-project requiredChecks", "    requiredChecks: [Gate]\n"],
    ["per-project reviewRubric", "    reviewRubric: be nice\n"],
  ])("rejects removed key: %s", (_n, extra) => {
    expect(() => load(`ownerUserId: 9\nprojects:\n  - repo: acme/a\n${extra}`)).toThrow();
  });

  it("rejects host-level labels", () => {
    expect(() => load("ownerUserId: 9\nlabels:\n  paused: x\nprojects:\n  - repo: acme/a\n")).toThrow();
  });

  it("fails clearly when archangel.yaml is missing (no environment-only config)", () => {
    expect(() => loadProjectConfigs({ configPath: path.join(os.tmpdir(), "no-such-archangel.yaml"), env })).toThrow(/Host config not found/);
  });
});
