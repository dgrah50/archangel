import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/core/doctor.js";

describe("doctor landing configuration schema", () => {
  it("fails on unknown keys and passes valid landing JSON", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-landing-doc-"));
    const yamlPath = path.join(tmp, "archangel.yaml");
    const pem = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      .export({ type: "pkcs1", format: "pem" }).toString();
    fs.writeFileSync(yamlPath, `ownerUserId: 999\nauthMode: api\ndataDir: ${path.join(tmp, "data")}\nprojects:\n  - repo: dgrah50/gijq\n`);

    let landing = JSON.stringify({ gate: {} });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname.endsWith("/access_tokens")) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token: "ghs_doc", expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: { contents: "write", pull_requests: "write", issues: "write", checks: "read" } }));
      } else if (url.pathname.endsWith("/git/ref/heads/main")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: { sha: "abc1234567890" } }));
      } else if (url.pathname.includes("/contents/.github/workflows/archangel-gate.yml") || url.pathname.includes("/contents/.pre-commit-config.yaml")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "present" }));
      } else if (url.pathname.includes("/contents/.agents/landing.json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ encoding: "base64", content: Buffer.from(landing).toString("base64") }));
      } else if (url.pathname.endsWith("/labels")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(["ready-for-agent", "factory:paused", "factory:stop", "needs-you", "factory:disagree"].map((name) => ({ name }))));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const env: NodeJS.ProcessEnv = {
      ARCHANGEL_GITHUB_APP_ID: "123", ARCHANGEL_GITHUB_INSTALLATION_ID: "456", ARCHANGEL_GITHUB_PRIVATE_KEY_PEM: pem,
      ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai", GOOGLE_GENERATIVE_AI_API_KEY: "sk-gem",
    };
    try {
      const bad = await runDoctor({ configPath: yamlPath, env, apiBaseUrl: `http://127.0.0.1:${port}` });
      const badCheck = bad.checks.find((check) => check.id.startsWith("repo_verification"));
      expect(badCheck?.status).toBe("fail");
      expect(badCheck?.detail).toMatch(/Unrecognized key|gate/);

      landing = JSON.stringify({ maxFiles: 5 });
      const good = await runDoctor({ configPath: yamlPath, env, apiBaseUrl: `http://127.0.0.1:${port}` });
      expect(good.checks.find((check) => check.id.startsWith("repo_verification"))?.status).toBe("pass");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
