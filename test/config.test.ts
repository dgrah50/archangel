import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadProjectConfigs, mergeLandingJson } from "../src/config.js";
import { loadDotEnv, parseDotEnv } from "../src/env.js";

describe("2-layer project, .env, landing.json & workflow config", () => {
  it("loads .env without overriding existing env and reads ARCHANGEL_GITHUB_PRIVATE_KEY_PATH", () => {
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
        `ownerUserId: 999\nprojects:\n  - repo: dgrah50/gijq\n    language: go\n`,
      );
      const cfgs = loadProjectConfigs({
        configPath: yamlPath,
        env: {
          ...targetEnv,
          ARCHANGEL_GITHUB_INSTALLATION_ID: "1234",
        },
      });
      expect(cfgs[0]?.githubPrivateKeyPem).toContain("BEGIN RSA PRIVATE KEY");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("loads multi-project archangel.yaml and injects secrets strictly from env", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-cfg-"));
    const yamlPath = path.join(tmp, "archangel.yaml");
    try {
      fs.writeFileSync(
        yamlPath,
        `
ownerUserId: 999
maxDailyUsd: 15
projects:
  - repo: dgrah50/gijq
    language: go
    shadowMode: true
    gate:
      maxNonTestLines: 120
      extraProtectedPaths: ["migrations/**"]
  - repo: dgrah50/other
    language: go
    githubInstallationId: 55555
    shadowMode: false
`,
      );

      const projects = loadProjectConfigs({
        configPath: yamlPath,
        env: {
          ARCHANGEL_GITHUB_APP_ID: "123",
          ARCHANGEL_GITHUB_INSTALLATION_ID: "44444",
          ARCHANGEL_GITHUB_PRIVATE_KEY_PEM: "fake-pem",
          ANTHROPIC_API_KEY: "sk-ant-test",
        },
      });

      expect(projects).toHaveLength(2);
      expect(projects[0]?.githubRepo).toBe("gijq");
      expect(projects[0]?.githubInstallationId).toBe(44444);
      expect(projects[0]?.gate.maxNonTestLines).toBe(120);
      expect(projects[0]?.gate.extraProtectedPaths).toEqual(["migrations/**"]);
      expect(projects[0]?.anthropicApiKey).toBe("sk-ant-test");

      expect(projects[1]?.githubRepo).toBe("other");
      expect(projects[1]?.githubInstallationId).toBe(55555);
      expect(projects[1]?.shadowMode).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("allows .agents/landing.json to tighten bounds and add protected paths, never loosen them", () => {
    const merged = mergeLandingJson(
      { maxNonTestLines: 150, maxTotalLines: 300, maxFiles: 5, extraProtectedPaths: ["proto/**"] },
      ["Gate"],
      "Host rubric",
      JSON.stringify({
        maxNonTestLines: 80,
        maxTotalLines: 999,
        maxFiles: 10,
        extraProtectedPaths: ["migrations/**"],
        requiredChecks: ["Lint"],
        reviewRubric: "Repo rubric",
      }),
    );

    expect(merged.gate.maxNonTestLines).toBe(80);
    expect(merged.gate.maxTotalLines).toBe(300);
    expect(merged.gate.maxFiles).toBe(5);
    expect(merged.gate.extraProtectedPaths).toEqual(["proto/**", "migrations/**"]);
    expect(merged.requiredChecks).toEqual(["Gate", "Lint"]);
    expect(merged.reviewRubric).toContain("Host rubric");
    expect(merged.reviewRubric).toContain("Repo rubric");
  });

  it("validates workflows/archangel-gate.yml security invariants", () => {
    const raw = fs.readFileSync(path.resolve("workflows/archangel-gate.yml"), "utf8");
    const doc = parseYaml(raw) as Record<string, unknown>;
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(doc.on).toHaveProperty("pull_request");
    expect(doc.on).not.toHaveProperty("pull_request_target");
    const jobs = doc.jobs as Record<string, Record<string, unknown>>;
    expect(jobs.gate?.name).toBe("Gate");
    expect(jobs.gate?.if).toBeUndefined(); // No job-level skip so human PRs never deadlock
    expect(raw).toContain("ARCHANGEL_GATE_SHA");
    expect(raw).toContain("--policy-from-base");
    expect(raw).toContain("--revert-of");
  });
});
