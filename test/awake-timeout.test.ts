import { describe, expect, it } from "bun:test";
import { awakeTimeout } from "../src/core/spawn-group.js";

/** Runs a 30ms awake timeout against a clock that advances by `steps` per poll; returns how many polls it took. */
async function pollsToFire(steps: number[]): Promise<number> {
  let polls = 0;
  let clock = 0;
  const now = () => (clock += steps[Math.min(polls++, steps.length - 1)] ?? 0);
  await new Promise<void>((resolve) => awakeTimeout(30, resolve, { pollMs: 1, now }));
  return polls;
}

describe("awakeTimeout", () => {
  it("fires on awake time and does not charge a host-sleep gap", async () => {
    expect(await pollsToFire([0, 10, 10, 10, 10])).toBe(4);
    expect(await pollsToFire([0, 10, 3_600_000, 10, 10, 10, 10])).toBe(5);
  });
});
