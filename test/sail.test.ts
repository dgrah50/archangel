import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { GitBroker, MAX_RESULT_BUNDLE_BYTES } from "../src/broker/git-broker.js";
import { SailProvider, SailSpend, type SailBoxInfo, type SailClient } from "../src/compute/sail.js";

/** A Sail client that keeps boxes in memory; `files` is what `readFile` returns and `exitFor` can fail a command. */
function fakeClient(files: Record<string, Buffer> = {}, stdoutFor: (script: string) => string = () => "") {
  const boxes = new Map<string, SailBoxInfo>();
  const terminated: string[] = [];
  let created = 0;
  const client: SailClient = {
    findBox: async (name) => [...boxes.values()].find((b) => b.name === name) ?? null,
    createBox: async ({ name }) => {
      const b = { id: `box-${++created}`, name };
      boxes.set(b.id, b);
      return b;
    },
    run: async (_id, spec) => ({ code: spec.argv[0] === "cat" ? 1 : 0, stdout: stdoutFor(spec.argv.join(" ")), stderr: "", timedOut: false }),
    writeFile: async () => undefined,
    readFile: async (_id, p) => files[p] ?? Buffer.alloc(0),
    terminate: async (id) => {
      if (boxes.delete(id)) terminated.push(id);
    },
    list: async (prefix) => [...boxes.values()].filter((b) => b.name.startsWith(prefix)),
  };
  return { client, boxes, terminated, created: () => created };
}

function setup(client: SailClient, maxDailyComputeUsd = 5) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-sailtest-"));
  const bare = path.join(dir, "broker.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const broker = new GitBroker({ bareRepoPath: bare, clonesDir: path.join(dir, "clones") });
  const provider = new SailProvider({
    client,
    broker: { createStartBundle: async () => path.join(dir, "start.bundle"), verifyBundle: (p) => broker.verifyBundle(p) },
    namePrefix: "archangel-",
    maxLifetimeSeconds: 600,
    maxDailyComputeUsd,
    spend: new SailSpend(path.join(dir, "spend.json")),
  });
  fs.writeFileSync(path.join(dir, "start.bundle"), "x");
  return { provider, dir };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("SailProvider", () => {
  it("destroy is idempotent and the sweep kills only unowned prefixed boxes", async () => {
    const f = fakeClient();
    const { provider } = setup(f.client);
    const owned = await provider.prepare({ issueNumber: 1, startSha: "a".repeat(40) });
    f.boxes.set("orphan", { id: "orphan", name: "archangel-9-deadbeef" });
    f.boxes.set("other", { id: "other", name: "someone-elses-box" });

    expect(await provider.sweepOrphans()).toEqual(["orphan"]);
    expect([...f.boxes.keys()].sort()).toEqual(["box-1", "other"]);

    provider.destroy(owned);
    provider.destroy(owned);
    await settle();
    expect(f.terminated).toEqual(["orphan", "box-1"]);
  });

  it("refuses a new box past maxDailyComputeUsd", async () => {
    const f = fakeClient();
    const { provider } = setup(f.client, 0.01);
    await expect(provider.prepare({ issueNumber: 1, startSha: "a".repeat(40) })).rejects.toThrow("compute cap");
    expect(f.created()).toBe(0);
  });

  it("collect rejects a bundle that fails verify or exceeds the size cap", async () => {
    const junk = fakeClient({ "/work/out.bundle": Buffer.from("not a bundle") }, (s) => (s.includes("stat -c") ? "12\n" : ""));
    const a = setup(junk.client);
    const ws = await a.provider.prepare({ issueNumber: 1, startSha: "a".repeat(40) });
    await expect(a.provider.collect(ws)).rejects.toThrow();

    const huge = fakeClient({}, (s) => (s.includes("stat -c") ? `${MAX_RESULT_BUNDLE_BYTES + 1}\n` : ""));
    const b = setup(huge.client);
    const ws2 = await b.provider.prepare({ issueNumber: 1, startSha: "a".repeat(40) });
    await expect(b.provider.collect(ws2)).rejects.toThrow("cap");
  });

  it("collect reports an Attempt with no new commits as empty, and the Broker validates it as an unchanged start", async () => {
    let start = "";
    const empty = fakeClient({}, (s) => (s.includes("rev-list --count") ? `EMPTY ${start}\n` : ""));
    const { provider, dir } = setup(empty.client);
    const work = path.join(dir, "work");
    execFileSync("git", ["init", "-q", work]);
    const git = (...a: string[]) => execFileSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(work, "a.txt"), "a");
    git("add", "-A");
    git("commit", "-q", "-m", "start");
    start = git("rev-parse", "HEAD");
    execFileSync("git", ["-C", work, "push", "-q", path.join(dir, "broker.git"), "HEAD:refs/heads/main"]);

    const ws = await provider.prepare({ issueNumber: 1, startSha: start });
    const collected = await provider.collect(ws);
    expect(collected).toEqual({ kind: "empty", startSha: start });

    fs.mkdirSync(path.join(dir, "clones"));
    const broker = new GitBroker({ bareRepoPath: path.join(dir, "broker.git"), clonesDir: path.join(dir, "clones") });
    const gate = { maxNonTestLines: 100, maxTotalLines: 100, maxFiles: 10, extraProtectedPaths: [], testFileGlobs: [], testDataGlobs: [] } as never;
    const v = await broker.fetchAndValidateCollected(collected, 1, start, gate);
    expect(v.headSha).toBe(start);
    expect(v.changedFiles).toEqual([]);
    expect(await broker.isAlreadyOnMain(start, start)).toBe(true);
  });
});
