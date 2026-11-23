import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { SubscriptionImplementer } from "../src/agents/subscription-implementer.js";
import { AgentSandboxProvider, buildAgentProfile } from "../src/compute/agent-sandbox.js";
import { execInGroup } from "../src/compute/local.js";
import type { ComputeProvider, ExecSpec } from "../src/compute/provider.js";
import { canSandbox } from "./helpers/can-sandbox.js";

const never = async (): Promise<never> => {
  throw new Error("not used");
};
const inner = (exec: ComputeProvider["exec"]): ComputeProvider => ({ prepare: never, exec, collect: never, destroy: () => undefined, expose: never, install: never, list: async () => [] });

test("a sandboxed run reaches its workspace, temp dir and own login, and nothing else on the machine", async () => {
  // Whatever the PATH or an owner's extra path says, the profile never opens the home directory or anything above it.
  const profile = buildAgentProfile({ workspace: "/w", home: "/Users/o", tools: ["/Users/o", "/Users", "/", "/Users/o/.bun/bin"], scratch: ["/Users/o"], confine: { state: ["/Users/o/logins/codex"], keychain: "service" } });
  expect(profile).not.toMatch(/\(subpath "(\/|\/Users|\/Users\/o)"\)/);
  expect(profile).toContain('(subpath "/Users/o/.bun/bin")');
  expect(profile).not.toContain("Library/Keychains");
  if (!canSandbox) return;

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-sb-")));
  const [ws, tmp, state, elsewhere] = ["ws", "tmp", "state", "elsewhere"].map((d) => path.join(root, d)) as [string, string, string, string];
  for (const d of [ws, tmp, state, elsewhere]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(elsewhere, "secret"), "s3cret");
  const provider = new AgentSandboxProvider(inner((w, spec) => execInGroup(w.path, spec)), { read: [], write: [], profileDir: path.join(root, "profiles") });
  const sh = (script: string) =>
    provider.exec({ id: ws, path: ws }, { cmd: "/bin/sh", args: ["-c", script], env: { PATH: "/usr/bin:/bin", TMPDIR: tmp }, timeoutMs: 20_000, confine: { state: [state], keychain: "none" } });

  const ok = await sh(`echo a > made && echo b > "${tmp}/t" && echo c > "${state}/login" && cat made`);
  expect(ok.code).toBe(0);
  expect(ok.stdout.trim()).toBe("a");
  expect((await sh(`cat "${elsewhere}/secret"`)).stdout).not.toContain("s3cret");
  expect((await sh(`echo x > "${elsewhere}/planted"`)).code).not.toBe(0);
  expect(fs.existsSync(path.join(elsewhere, "planted"))).toBe(false);
  expect((await sh(`ls "${os.homedir()}"`)).code).not.toBe(0);
});

test("under a confining provider each CLI runs without its own sandbox and is handed only its own login", async () => {
  const calls: ExecSpec[] = [];
  const compute: ComputeProvider = { ...inner(async (_ws, spec) => (calls.push(spec), { code: 0, stdout: "", stderr: "", aborted: false, durationMs: 1, peakRssKb: null })), confines: true };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sb-impl-"));
  const run = async (provider: "claude" | "codex" | "agy", home?: string) => {
    calls.length = 0;
    const chain = [{ provider }];
    const impl = new SubscriptionImplementer({ chains: { implement: chain, revise: chain, rebase: chain }, accounts: [{ id: "a", provider, ...(home ? { home } : {}) }], transcriptsDir: dir });
    const res = await impl.run({ issueNumber: 1, workspaces: { local: { compute, workspace: async () => ({ id: "w", path: "/w" }) } }, prompt: "p", abortController: new AbortController(), timeoutMs: 1000, role: "implement" });
    return { res, cli: calls.find((c) => c.cmd !== "git") };
  };

  const codex = (await run("codex", "/logins/codex")).cli!;
  expect(codex.cmd).toBe("codex");
  expect(codex.args).toContain("danger-full-access");
  expect(codex.confine).toEqual({ state: ["/logins/codex"], keychain: "service" });

  // Not wrapped in agy's own keychain-deny sandbox-exec, and not given --sandbox: the provider's profile does both jobs.
  const agy = (await run("agy", "/logins/agy")).cli!;
  expect(agy.cmd).toBe("agy");
  expect(agy.args).not.toContain("--sandbox");
  expect(agy.confine).toEqual({ state: ["/logins/agy"], keychain: "none" });

  expect((await run("claude")).cli!.confine).toEqual({ state: [], keychain: "login" });

  // A codex login in the owner's own home is never handed to a sandboxed run.
  await expect(run("codex")).rejects.toThrow(/home of its own/);
  expect(calls.some((c) => c.cmd === "codex")).toBe(false);
});
