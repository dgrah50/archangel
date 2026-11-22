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

async function doctorWithPolicy(policyText: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-doctor-policy-"));
  const yamlPath = path.join(tmp, "archangel.yaml");
  const binPath = path.join(tmp, "bin");
  fs.mkdirSync(binPath);
  for (const [name, output] of [["git", "git version 2.40.0"], ["paseo", "paseo 0.16.2"]] as const) {
    const commandPath = path.join(binPath, name);
    fs.writeFileSync(commandPath, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
    fs.chmodSync(commandPath, 0o755);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${binPath}:${originalPath ?? ""}`;
  fs.writeFileSync(yamlPath, `ownerUserId: 999\nauthMode: api\ndataDir: ${path.join(tmp, "data")}\nprojects:\n  - repo: acme/app\n`);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname.endsWith("/access_tokens")) {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ token: "ghs_doc", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: "write", pull_requests: "write", issues: "write", checks: "read" } }));
    } else if (url.pathname.endsWith("/git/ref/heads/main")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: { sha: "abc1234567890" } }));
    } else if (url.pathname.includes("/contents/.agents/archangel.json")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content: Buffer.from(policyText).toString("base64"), encoding: "base64" }));
    } else if (url.pathname.includes("/contents/.github/workflows/archangel-gate.yml")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "archangel-gate.yml" }));
    } else if (url.pathname.endsWith("/labels")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(["ready-for-agent", "factory:paused", "factory:stop", "needs-you", "factory:disagree"].map((name) => ({ name }))));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const env: NodeJS.ProcessEnv = {
    ARCHANGEL_GITHUB_APP_ID: "123",
    ARCHANGEL_GITHUB_INSTALLATION_ID: "456",
    ARCHANGEL_GITHUB_PRIVATE_KEY_PEM: makeKey(),
    ANTHROPIC_API_KEY: "sk-ant",
    OPENAI_API_KEY: "sk-oai",
    GOOGLE_GENERATIVE_AI_API_KEY: "sk-gem",
  };
  try {
    return await runDoctor({ configPath: yamlPath, env, apiBaseUrl: `http://127.0.0.1:${port}` });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe("doctor policy validation regression", () => {
  it("fails when the policy is not valid JSON", async () => {
    const report = await doctorWithPolicy("{");
    const check = report.checks.find((item) => item.id.startsWith("repo_verification"));
    expect(check?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("fails when the policy has unrecognized top-level keys", async () => {
    const report = await doctorWithPolicy('{"gate": {}}');
    const check = report.checks.find((item) => item.id.startsWith("repo_verification"));
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("Unrecognized key");
  });

  it("passes a valid policy", async () => {
    const report = await doctorWithPolicy('{"maxFiles": 5}');
    expect(report.checks.find((item) => item.id.startsWith("repo_verification"))?.status).toBe("pass");
    expect(report.ok).toBe(true);
  });
});
