import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfigs, mergeLandingJson } from "../src/config.js";

describe("2-layer project & landing.json config", () => {
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
        maxNonTestLines: 80, // tightens -> allowed
        maxTotalLines: 999, // tries to loosen -> clamped to 300!
        maxFiles: 10, // tries to loosen -> clamped to 5!
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
});
