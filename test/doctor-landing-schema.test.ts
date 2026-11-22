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

describe("doctor landing config schema", () => {
  it.each([
    ["invalid JSON syntax", "{" , "Invalid .agents/landing.json JSON"],
    ["unrecognized top-level keys", '{"gate": {}}', "Invalid .agents/landing.json at <root>"],
    ["valid config", '{"maxFiles": 5}', ".agents/landing.json valid"],
  ])("%s", async (_name, landing, expected) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-landing-"));
    const yamlPath = path.join(tmp, "archangel.yaml");
    fs.writeFileSync(yamlPath, `ownerUserId: 999\nauthMode: api\ndataDir: ${path.join(tmp, "data")}\nprojects:\n  - repo: acme/app\n`);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname.endsWith("/access_tokens")) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token: "ghs_test", expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: { contents: "write", pull_requests: "write", issues: "write", checks: "read" } }));
      } else if (url.pathname.endsWith("/git/ref/heads/main")) {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ object: { sha: "abc123" } }));
      } else if (url.pathname.includes("/contents/.agents/landing.json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ encoding: "base64", content: Buffer.from(landing).toString("base64") }));
      } else if (url.pathname.includes("/contents/")) {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
      } else if (url.pathname.endsWith("/labels")) {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end("[]");
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const env: NodeJS.ProcessEnv = {
      ARCHANGEL_GITHUB_APP_ID: "123", ARCHANGEL_GITHUB_INSTALLATION_ID: "456",
      ARCHANGEL_GITHUB_PRIVATE_KEY_PEM: makeKey(), ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai", GOOGLE_GENERATIVE_AI_API_KEY: "sk-gem",
    };
    try {
      const report = await runDoctor({ configPath: yamlPath, env, apiBaseUrl: `http://127.0.0.1:${port}` });
      const check = report.checks.find((item) => item.id === "repo_verification:acme/app");
      expect(check?.detail).toContain(expected);
      expect(check?.status).toBe(_name === "valid config" ? "pass" : "fail");
      expect(report.ok).toBe(_name === "valid config");
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
