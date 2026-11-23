import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { LocalProvider } from "../src/compute/local.js";
import type { ComputeProvider, Exposed } from "../src/compute/provider.js";
import { pocWorkspaceDir, startPocPreview, type WebPreview } from "../src/core/pitch-preview.js";
import { stepPoc, type PocState } from "../src/core/poc-machine.js";
import { Ledger } from "../src/ledger/store.js";

const SHA = "a".repeat(40);
const preview: WebPreview = { kind: "web", install: ["true"], start: ["node", "server.js"], port: 4000, readyPath: "/", shots: ["/about"], allowInstallScripts: false };

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-preview-"));
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  ledger.recordPitch({ issueNumber: 5, scoutName: "s", trustHash: "t", title: "A pitch title", titleFp: "fp", contentSha256: "c", pitchJson: "{}" });
  ledger.reservePocBuild(5);
  ledger.stepPocState(5, { t: "built", headSha: SHA, at: 1 });
  fs.mkdirSync(pocWorkspaceDir(dataDir, "acme/app", 5), { recursive: true });
  return { dataDir, ledger, broker: { resolveRef: async () => SHA } };
}

describe("PoC preview", () => {
  it("a preview never starts without a sandboxing provider, and the PoC stays ready", async () => {
    const { dataDir, ledger, broker } = fixture();
    const local = new LocalProvider({} as never);
    await expect(startPocPreview({ ledger, broker, local, sandbox: local, preview, dataDir, installTimeoutMs: 1000 }, 5)).rejects.toThrow("no sandbox");
    expect(ledger.getPoc(5)!.state.kind).toBe("ready");
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("runs, stores re-encoded screenshots of the declared pages, and stops", async () => {
    const { dataDir, ledger, broker } = fixture();
    let stop!: () => void;
    const closed = new Promise<void>((r) => (stop = r));
    const exposed: Exposed = { url: "http://127.0.0.1:31005", close: () => stop(), closed };
    const sandbox = { expose: async () => exposed } as unknown as ComputeProvider;
    const page = (w: number) => sharp({ create: { width: w, height: 30, channels: 3, background: "#369" } }).png().toBuffer();
    const urls: string[] = [];
    const screenshot = async (url: string) => (urls.push(url), Buffer.concat([await page(40 + urls.length), Buffer.from("<script>PAYLOAD</script>")]));
    const run = await startPocPreview({ ledger, broker, local: {} as never, sandbox, preview, dataDir, installTimeoutMs: 1000, screenshot }, 5);

    expect(ledger.getPoc(5)!.state.kind).toBe("running");
    expect(urls).toEqual(["http://127.0.0.1:31005/", "http://127.0.0.1:31005/about"]);
    const shots = ledger.listPitchAttachments().filter((a) => a.kind === "capture");
    expect(shots.map((a) => a.source)).toEqual([`/@${SHA}`, `/about@${SHA}`]);
    for (const s of shots) expect(fs.readFileSync(path.join(dataDir, "pitch-assets", `${s.sha256}.png`)).includes("PAYLOAD")).toBe(false);

    run.close();
    await run.closed;
    expect(ledger.getPoc(5)!.state).toMatchObject({ kind: "stopped", reason: "owner" });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("only a built PoC starts a preview, and only a running one stops", () => {
    const ready: PocState = { kind: "ready", headSha: SHA, builtAt: 1 };
    const running = stepPoc(ready, { t: "preview_started", at: 2, expiresAt: 9 });
    expect(running).toEqual({ ok: true, next: { kind: "running", since: 2, expiresAt: 9 } });
    expect(stepPoc((running as { next: PocState }).next, { t: "preview_started", at: 3, expiresAt: 9 }).ok).toBe(false);
    const stopped = stepPoc((running as { next: PocState }).next, { t: "preview_stopped", reason: "ttl", at: 9 });
    expect(stopped).toEqual({ ok: true, next: { kind: "stopped", reason: "ttl", at: 9 } });
    expect(stepPoc(ready, { t: "preview_stopped", reason: "owner", at: 3 }).ok).toBe(false);
    expect(stepPoc({ kind: "building", since: 1 }, { t: "preview_started", at: 2, expiresAt: 9 }).ok).toBe(false);
    expect(stepPoc((stopped as { next: PocState }).next, { t: "preview_started", at: 10, expiresAt: 19 }).ok).toBe(true);
  });
});
