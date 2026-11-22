import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/core/doctor.js";

function makeKey(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

describe("archangel doctor (Neon P3)", () => {
  it("fails online check when GitHub App has forbidden workflows/administration permission and passes with least privilege", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-doc-"));
    const yamlPath = path.join(tmp, "archangel.yaml");
    const pem = makeKey();
    fs.writeFileSync(
      yamlPath,
      `ownerUserId: 999\nauthMode: api\ndataDir: ${path.join(tmp, "data")}\nprojects:\n  - repo: acme/app\n`,
    );

    let grantForbidden = true;
    let hasRepoPolicy = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname.endsWith("/access_tokens")) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token: "ghs_doc",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: grantForbidden
              ? { contents: "write", pull_requests: "write", issues: "write", checks: "read", workflows: "write" }
              : { contents: "write", pull_requests: "write", issues: "write", checks: "read" },
          }),
        );
        return;
      }
      if (url.pathname.endsWith("/git/ref/heads/main")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: { sha: "abc1234567890" } }));
        return;
      }
      if (url.pathname.includes("/contents/.github/workflows/archangel-gate.yml")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "archangel-gate.yml", sha: "s1", encoding: "base64", content: Buffer.from("x").toString("base64") }));
        return;
      }
      if (hasRepoPolicy && url.pathname.includes("/contents/.agents/archangel.json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "archangel.json", sha: "s2", encoding: "base64", content: Buffer.from("{}").toString("base64") }));
        return;
      }
      if (url.pathname.endsWith("/labels")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify([
            { name: "ready-for-agent" },
            { name: "factory:paused" },
            { name: "factory:stop" },
            { name: "needs-you" },
            { name: "factory:disagree" },
          ]),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const env: NodeJS.ProcessEnv = {
      ARCHANGEL_GITHUB_APP_ID: "123",
      ARCHANGEL_GITHUB_INSTALLATION_ID: "456",
      ARCHANGEL_GITHUB_PRIVATE_KEY_PEM: pem,
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
      GOOGLE_GENERATIVE_AI_API_KEY: "sk-gem",
    };

    try {
      const bad = await runDoctor({ configPath: yamlPath, env, apiBaseUrl: `http://127.0.0.1:${port}` });
      expect(bad.ok).toBe(false);
      expect(bad.checks.find((c) => c.id.startsWith("github_app_permissions"))?.status).toBe("fail");
      expect(bad.checks.find((c) => c.id.startsWith("repo_verification"))?.status).toBe("fail");

      grantForbidden = false;
      hasRepoPolicy = true;
      const good = await runDoctor({ configPath: yamlPath, env, apiBaseUrl: `http://127.0.0.1:${port}` });
      expect(good.ok).toBe(true);
      expect(good.checks.find((c) => c.id.startsWith("github_app_permissions"))?.status).toBe("pass");
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe("reviewer independence", () => {
  it("flags implementer vendors that leave fewer than 2 independent reviewers", async () => {
    const { findReviewerIndependenceGaps } = await import("../src/core/doctor.js");
    const mk = (impl: string[], rev: string[]) => ({
      authMode: "subscription" as const,
      implementerChain: impl.map((provider) => ({ provider })) as never,
      reviewerChain: rev.map((provider) => ({ provider })) as never,
    });
    expect(findReviewerIndependenceGaps(mk(["codex"], ["agy", "claude", "codex"]))).toEqual([]);
    expect(findReviewerIndependenceGaps(mk(["codex", "claude"], ["agy", "claude"])).length).toBeGreaterThan(0);
  });
});

describe("landing mode report", () => {
  it("shows the effective bugfix landing mode and who decided it", async () => {
    const { describeLanding } = await import("../src/core/doctor.js");
    const { okWorkflow } = await import("./helpers/workflow.js");
    const auto = { landing: { bugfix: "autonomous" } };
    expect(describeLanding("a/b", okWorkflow([], { extra: auto })).detail).toContain("autonomous (source: repo");
    expect(describeLanding("a/b", okWorkflow([], { extra: auto, host: { shadowMode: true } })).detail)
      .toBe("owner (source: host; repo declares autonomous)");
    expect(describeLanding("a/b", okWorkflow([])).detail).toContain("owner (source: repo");
    const missing = describeLanding("a/b", { repo: "a/b", mainSha: "x", status: "missing", error: "gone" });
    expect(missing.status).toBe("warn");
    expect(missing.detail).toContain("halted");
  });
});
