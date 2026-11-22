import { expect, it } from "bun:test";
import { execInGroup } from "../src/compute/local.js";

it("the peak-RSS poller measures the process tree and is stopped when the process exits", async () => {
  const made: unknown[] = [];
  const cleared = new Set<unknown>();
  const { setInterval: realSet, clearInterval: realClear } = globalThis;
  globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => {
    const t = realSet(...a);
    made.push(t);
    return t;
  }) as typeof setInterval;
  globalThis.clearInterval = ((t: Parameters<typeof clearInterval>[0]) => {
    cleared.add(t);
    realClear(t);
  }) as typeof clearInterval;
  try {
    const res = await execInGroup(process.cwd(), { cmd: "sh", args: ["-c", "sleep 0.4"], env: { PATH: process.env.PATH }, timeoutMs: 10_000, rssPollMs: 20 });
    expect(res.code).toBe(0);
    expect(res.peakRssKb).toBeGreaterThan(0);
    expect(made.length).toBeGreaterThan(0);
    expect(cleared.size).toBe(made.length);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});
