import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { resolveDataDir } from "../src/cli/data-dir.js";
import { HostYamlSchema, REPO_SLUG_RE, accountHomeProblems, loadProjectConfigs } from "../src/config.js";
import { loadDotEnv, parseDotEnv } from "../src/env.js";
import type { OnboardRunner } from "../src/core/onboard.js";
import { planWorkflowProposal } from "../src/core/workflow-propose.js";

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

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "archangel-datadir-"));
}

describe("resolveDataDir", () => {
  it("prefers --data-dir, then the host config's dataDir, then ARCHANGEL_DATA_DIR / the default", () => {
    const dir = tmp();
    try {
      const cfg = path.join(dir, "archangel.yaml");
      fs.writeFileSync(cfg, `ownerUserId: 1\ndataDir: ${dir}/custom\nprojects:\n  - repo: a/b\n`);
      expect(resolveDataDir({ dataDir: "/x" }, {})).toBe("/x");
      expect(resolveDataDir({ config: cfg }, {})).toBe(`${dir}/custom`);
      expect(resolveDataDir({}, { ARCHANGEL_CONFIG: cfg })).toBe(`${dir}/custom`);
      expect(resolveDataDir({}, { ARCHANGEL_DATA_DIR: "/env", ARCHANGEL_CONFIG: path.join(dir, "missing.yaml") })).toBe("/env");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly on an invalid host config instead of opening the default Ledger", () => {
    const dir = tmp();
    try {
      const cfg = path.join(dir, "archangel.yaml");
      fs.writeFileSync(cfg, `ownerUserId: 1\ndataDir: ${dir}/custom\nmaxSomethingRemoved: 3\nprojects:\n  - repo: a/b\n`);
      expect(() => resolveDataDir({ config: cfg }, {})).toThrow();
      expect(() => resolveDataDir({ config: path.join(dir, "nope.yaml") }, {})).toThrow(/ENOENT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const project = (repo: string) => ({ repo });
const host = (...repos: string[]) => HostYamlSchema.safeParse({ ownerUserId: 1, projects: repos.map(project) });

describe("repo slugs", () => {
  it("accepts GitHub-shaped owner/name and rejects spaces, URL metacharacters and dot segments", () => {
    for (const ok of ["acme/app", "Acme-Inc/my_repo.js", "dgrah50/.github", "a/b"]) expect(REPO_SLUG_RE.test(ok), ok).toBe(true);
    for (const bad of ["acme/..", "acme/.", "../app", "acme/a b", "acme/app?x=1", "acme/app#frag", "acme/a&b", "acme/app/extra", "-acme/app", "acme", "/app", "acme/"]) {
      expect(REPO_SLUG_RE.test(bad), bad).toBe(false);
    }
  });

  it("rejects a loose slug in the host config and in commands that interpolate it into gh/REST paths", async () => {
    expect(host("acme/app?x=1").success).toBe(false);
    expect(host("acme/..").success).toBe(false);
    const runner: OnboardRunner = { async run() { throw new Error("must not be called"); } };
    await expect(planWorkflowProposal(runner, "acme/..", "{}")).rejects.toThrow(/Expected owner\/name/);
  });
});

const hostWith = (extra: Record<string, unknown> = {}) => ({ ownerUserId: 1, projects: [{ repo: "a/b" }], ...extra });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "arc-accounts-"));

describe("accounts config", () => {
  it("rejects duplicate ids, a shared home, an unknown or wrong-provider account in a chain, and a chain provider with no account", () => {
    const base = [{ id: "codex", provider: "codex" }, { id: "agy", provider: "agy" }];
    const bad = (extra: Record<string, unknown>) => () => HostYamlSchema.parse(hostWith(extra));
    expect(bad({ accounts: [...base, { id: "codex", provider: "codex" }] })).toThrow(/duplicate account id 'codex'/);
    expect(bad({ accounts: [{ id: "a", provider: "claude", home: "/h/x" }, { id: "b", provider: "claude", home: "/h/x" }, ...base] })).toThrow(/share one home/);
    expect(bad({ accounts: [...base, { id: "claude", provider: "claude" }], chains: { revise: [{ provider: "codex", accounts: ["nope"] }] } })).toThrow(/unknown account 'nope'/);
    expect(bad({ accounts: [...base, { id: "claude", provider: "claude" }], chains: { revise: [{ provider: "codex", accounts: ["claude"] }] } })).toThrow(/is a claude account, not codex/);
    expect(bad({ accounts: base })).toThrow(/no account of that provider is configured/);
    expect(bad({ accounts: [{ id: "Bad_ID", provider: "codex" }, ...base] })).toThrow(/lowercase slug/);
  });

  it("checks that a configured home exists and holds a login (non-empty)", () => {
    const logged = tmpDir();
    fs.writeFileSync(path.join(logged, "auth.json"), "{}");
    const empty = tmpDir();
    const problems = accountHomeProblems([
      { id: "ok", provider: "codex", home: logged },
      { id: "empty", provider: "codex", home: empty },
      { id: "missing", provider: "claude", home: path.join(empty, "nope") },
      { id: "default", provider: "agy" },
    ]);
    expect(problems.map((p) => p.id)).toEqual(["empty", "missing"]);
    expect(problems[0]!.problem).toContain("log this account in");
  });

});
