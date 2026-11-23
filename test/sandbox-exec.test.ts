import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { LocalProvider } from "../src/compute/local.js";
import { SandboxExecProvider } from "../src/compute/sandbox-exec.js";
import type { Workspace } from "../src/compute/provider.js";

const NODE = "/opt/homebrew/bin/node";
const darwin = process.platform === "darwin" && fs.existsSync(NODE);
// CI is ubuntu: sandbox-exec exists only on macOS, so the sandbox tests run only on a dev Mac.
const onMac = it.skipIf(!darwin);

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archangel-sbtest-")));
  const ws: Workspace = { id: "ws", path: path.join(root, "ws") };
  fs.mkdirSync(ws.path);
  const provider = new SandboxExecProvider({} as never, { profileDir: path.join(root, "profiles"), killGraceMs: 200 });
  return { root, ws, provider };
}

const run = (p: SandboxExecProvider, ws: Workspace, code: string) =>
  p.exec(ws, { cmd: NODE, args: ["-e", code], env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" }, timeoutMs: 15_000 });

describe("sandbox provider", () => {
  it("LocalProvider refuses to expose: it has no sandbox", async () => {
    await expect(new LocalProvider({} as never).expose()).rejects.toThrow("no sandbox");
  });

  onMac("denies reads outside the workspace and non-loopback network", async () => {
    const { root, ws, provider } = fixture();
    try {
      const home = path.join(root, "home");
      fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
      fs.writeFileSync(path.join(home, ".ssh", "id"), "secret");
      fs.writeFileSync(path.join(ws.path, "ok.txt"), "fine");

      const read = await run(provider, ws, `const fs=require("fs");console.log(fs.readFileSync("ok.txt","utf8"));fs.readFileSync(${JSON.stringify(path.join(home, ".ssh", "id"))})`);
      expect(read.stdout).toContain("fine");
      expect(read.stderr).toContain("EPERM");

      const net = await run(provider, ws, `require("net").connect(443,"192.0.2.1").on("error",e=>console.log(e.code))`);
      expect(net.stdout.trim()).toBe("EPERM");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  onMac("the TTL stop kills the app's whole process group", async () => {
    const { root, ws, provider } = fixture();
    try {
      fs.writeFileSync(
        path.join(ws.path, "app.js"),
        `const {spawn}=require("child_process");const fs=require("fs");
const kid=spawn("/bin/sleep",["300"],{stdio:"ignore"});fs.writeFileSync("kid.pid",String(kid.pid));
require("http").createServer((q,r)=>r.end("ok")).listen(Number(process.env.PORT),"127.0.0.1");`,
      );
      const preview = await provider.expose(ws, { port: 0, ttlMs: 1500, cmd: NODE, args: ["app.js"] });
      expect((await fetch(preview.url)).status).toBe(200);
      const kid = Number(fs.readFileSync(path.join(ws.path, "kid.pid"), "utf8"));
      expect(() => process.kill(kid, 0)).not.toThrow();
      await preview.closed;
      await Bun.sleep(600);
      expect(() => process.kill(kid, 0)).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  // The install runs agent-written package.json files. CI has no sandbox-exec, so this runs only on a dev Mac with bun installed.
  const installOnMac = it.skipIf(!darwin || !!process.env.CI || !Bun.which("bun"));
  installOnMac("a malicious postinstall cannot reach a home outside the workspace, and scripts are skipped by default", async () => {
    const { root, ws, provider } = fixture();
    try {
      const home = path.join(root, "fakehome");
      fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
      fs.writeFileSync(path.join(home, ".ssh", "id"), "secret");
      const outside = path.join(root, "outside.txt");
      const probe = `const fs=require("fs");let leaked="no";try{fs.readFileSync(${JSON.stringify(path.join(home, ".ssh", "id"))});leaked="yes"}catch{}
try{fs.writeFileSync(${JSON.stringify(outside)},"x")}catch{}fs.writeFileSync("report.txt","ran leaked="+leaked)`;
      fs.writeFileSync(path.join(ws.path, "probe.js"), probe);
      fs.writeFileSync(path.join(ws.path, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { postinstall: "node probe.js" } }));

      const skipped = await provider.install(ws, { argv: ["bun", "install"], timeoutMs: 60_000 });
      expect(skipped.code).toBe(0);
      expect(fs.existsSync(path.join(ws.path, "report.txt"))).toBe(false);

      const allowed = await provider.install(ws, { argv: ["bun", "install"], timeoutMs: 60_000, allowScripts: true });
      expect(allowed.code).toBe(0);
      expect(fs.readFileSync(path.join(ws.path, "report.txt"), "utf8")).toBe("ran leaked=no");
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
