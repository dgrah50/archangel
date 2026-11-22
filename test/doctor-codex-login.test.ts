import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const execFile = vi.fn((_file: string, _args: string[], callback: (...args: unknown[]) => void) =>
    callback(null, { stdout: "Not logged in\n", stderr: "" }),
  );
  Object.defineProperty(execFile, promisify.custom, {
    value: async () => ({ stdout: "Not logged in\n", stderr: "" }),
  });
  return { execFile };
});

import { runDoctor } from "../src/core/doctor.js";

describe("codex subscription login check", () => {
  it("fails when codex reports that it is not logged in", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-codex-login-"));
    const configPath = path.join(tmp, "archangel.yaml");
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    fs.writeFileSync(
      configPath,
      `ownerUserId: 999\nauthMode: subscription\ndataDir: ${path.join(tmp, "data")}\nimplementerChain:\n  - provider: codex\nreviewerChain:\n  - provider: codex\n  - provider: claude\nprojects:\n  - repo: acme/app\n`,
    );
    const env = {
      ARCHANGEL_GITHUB_APP_ID: "123",
      ARCHANGEL_GITHUB_INSTALLATION_ID: "456",
      ARCHANGEL_GITHUB_PRIVATE_KEY_PEM: pem,
    };

    try {
      const report = await runDoctor({ configPath, env, offline: true });
      expect(report.checks.find((check) => check.id === "subscription_clis")?.status).toBe("fail");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
