import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfigs, mergeRepoPolicy } from "../src/config.js";
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

  it("allows .agents/archangel.json to tighten bounds and add protected paths, never loosen them", () => {
    const merged = mergeRepoPolicy(
      {
        maxNonTestLines: 150,
        maxTotalLines: 300,
        maxFiles: 5,
        extraProtectedPaths: ["proto/**"],
        testFileGlobs: [],
        testDataGlobs: [],
        baseTestRuns: 3,
        headTestRuns: 2,
      },
      ["Gate"],
      "Host rubric",
      JSON.stringify({
        maxNonTestLines: 80,
        maxTotalLines: 999,
        maxFiles: 10,
        extraProtectedPaths: ["migrations/**"],
        testFileGlobs: ["**/*_test.go"],
        testCmd: "go test ./...",
        baseTestRuns: 1,
        headTestRuns: 4,
        requiredChecks: ["Lint"],
        reviewRubric: "Repo rubric",
      }),
    );

    expect(merged.gate.maxNonTestLines).toBe(80);
    expect(merged.gate.maxTotalLines).toBe(300);
    expect(merged.gate.maxFiles).toBe(5);
    expect(merged.gate.baseTestRuns).toBe(3); // repo cannot loosen baseTestRuns below host
    expect(merged.gate.headTestRuns).toBe(4); // repo can tighten headTestRuns above host
    expect(merged.gate.testFileGlobs).toEqual(["**/*_test.go"]);
    expect(merged.gate.testCmd).toBe("go test ./...");
    expect(merged.gate.extraProtectedPaths).toEqual(["proto/**", "migrations/**"]);
    expect(merged.requiredChecks).toEqual(["Gate", "Lint"]);
    expect(merged.reviewRubric).toContain("Host rubric");
    expect(merged.reviewRubric).toContain("Repo rubric");
  });
});
