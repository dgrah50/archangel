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

describe("host limits", () => {
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

  it("lets a project override the host's attempt limits, and keeps the host value otherwise", () => {
    const [a, b] = load("ownerUserId: 9\nmaxImplementAttemptsPerThread: 5\nmaxRevisionsPerThread: 2\nprojects:\n  - repo: acme/a\n  - repo: acme/b\n    maxImplementAttemptsPerThread: 1\n");
    expect(a).toMatchObject({ maxImplementAttemptsPerThread: 5, maxRevisionsPerThread: 2 });
    expect(b).toMatchObject({ maxImplementAttemptsPerThread: 1, maxRevisionsPerThread: 2 });
  });

  it("fails clearly when archangel.yaml is missing (no environment-only config)", () => {
    expect(() => loadProjectConfigs({ configPath: path.join(os.tmpdir(), "no-such-archangel.yaml"), env })).toThrow(/Host config not found/);
  });
});
