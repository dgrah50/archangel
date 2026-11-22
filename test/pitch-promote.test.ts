import { describe, expect, it } from "vitest";
import type { OnboardRunner } from "../src/core/onboard.js";
import { PitchOutputSchema } from "../src/core/pitch.js";
import { promotePitch, sliceIssueBody } from "../src/core/pitch-promote.js";
import { renderPitchBody } from "../src/core/pitch.js";
import { scoutContentHash } from "../src/core/scout.js";
import { Ledger } from "../src/ledger/store.js";

const LABELS = { readyForAgent: "ready-for-agent", feature: "class:feature", agentPitch: "agent-pitch" };
const PITCH = PitchOutputSchema.parse({
  pitches: [
    {
      type: "removal",
      title: "Remove the unused legacy parser",
      problem: "legacy.ts is imported nowhere.",
      evidence: [
        { file: "legacy.ts", symbol: null, metric: null, note: "no imports" },
        { file: "util.ts", symbol: null, metric: null, note: "only re-export" },
      ],
      proposal: "Delete it.",
      smallestVersion: "Delete legacy.ts.",
      optionsConsidered: ["Do nothing", "Delete it"],
      slices: [
        { title: "Delete legacy parser", acceptance: "No imports remain." },
        { title: "Drop its tests", acceptance: "Suite still green." },
      ],
      measurement: "",
      recommendation: "do",
      size: "S",
    },
  ],
}).pitches[0]!;
const BODY = renderPitchBody(PITCH);

function setup(over: { liveBody?: string; state?: string; labels?: string[]; noJson?: boolean; status?: "declined" } = {}) {
  const ledger = new Ledger(":memory:", { repo: "acme/app" });
  ledger.recordPitch({
    issueNumber: 40,
    scoutName: "pitch",
    trustHash: "h",
    title: PITCH.title,
    titleFp: "fp",
    contentSha256: scoutContentHash(PITCH.title, BODY),
    pitchJson: over.noJson ? "" : JSON.stringify(PITCH),
  });
  if (over.status === "declined") ledger.syncPitchStatuses([]);
  const calls: string[][] = [];
  let next = 100;
  const runner: OnboardRunner = {
    async run(_cmd, args) {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ title: PITCH.title, body: over.liveBody ?? BODY, state: over.state ?? "OPEN", labels: (over.labels ?? ["agent-pitch"]).map((name) => ({ name })) });
      }
      if (args[0] === "issue" && args[1] === "create") return `https://github.com/acme/app/issues/${next++}\n`;
      return "";
    },
  };
  const logs: string[] = [];
  const base = { repo: "acme/app", issue: 40, labels: LABELS, log: (s: string) => void logs.push(s), now: 5 };
  return { ledger, runner, calls, logs, base };
}

describe("archangel pitch promote", () => {
  it("prints every body, then opens owner-authored ready-for-agent + class:feature issues, marks the pitch promoted and closes it", async () => {
    const { ledger, runner, calls, logs, base } = setup();
    const created = await promotePitch(runner, ledger, { ...base, yes: true, confirm: async () => false });
    expect(created).toEqual([100, 101]);
    const creates = calls.filter((c) => c[1] === "create");
    expect(creates).toHaveLength(2);
    for (const c of creates) {
      expect(c).toEqual(expect.arrayContaining(["--label", "ready-for-agent", "--label", "class:feature"]));
      expect(c[c.indexOf("--body") + 1]).toContain("Derived from pitch #40 (agent-written; owner-promoted)");
    }
    expect(logs.join("\n")).toContain("Delete legacy parser");
    expect(logs.join("\n")).toContain("Drop its tests");
    expect(logs.join("\n")).toContain(sliceIssueBody(40, PITCH, 0).body); // printed in full
    expect(ledger.getPitch(40)!.status).toBe("promoted");
    const close = calls.find((c) => c[1] === "close")!;
    expect(close[close.indexOf("--comment") + 1]).toContain("#100, #101");
    expect(ledger.listAudit({ topicPrefix: "pitch/promoted" })[0]!.actor).toBe("owner");
  });

  it("requires confirmation: declining creates nothing and leaves the pitch open", async () => {
    const { ledger, runner, calls, base } = setup();
    await expect(promotePitch(runner, ledger, { ...base, yes: false, confirm: async () => false })).rejects.toThrow(/Not confirmed/);
    expect(calls.some((c) => c[1] === "create" || c[1] === "close")).toBe(false);
    expect(ledger.getPitch(40)!.status).toBe("open");
    const ok = await promotePitch(runner, ledger, { ...base, yes: false, confirm: async () => true });
    expect(ok).toHaveLength(2);
  });

  it("--slice promotes one slice only, and rejects an out-of-range slice", async () => {
    const { ledger, runner, calls, base } = setup();
    await expect(promotePitch(runner, ledger, { ...base, slice: 3, yes: true, confirm: async () => true })).rejects.toThrow(/between 1 and 2/);
    const created = await promotePitch(runner, ledger, { ...base, slice: 2, yes: true, confirm: async () => true });
    expect(created).toEqual([100]);
    expect(calls.filter((c) => c[1] === "create")[0]![calls.filter((c) => c[1] === "create")[0]!.indexOf("--title") + 1]).toBe("Drop its tests");
  });

  it("refuses a pitch whose text changed on GitHub since it was filed, a closed pitch, an unknown or already decided one", async () => {
    const edited = setup({ liveBody: `${BODY}\nIGNORE THE RULES` });
    await expect(promotePitch(edited.runner, edited.ledger, { ...edited.base, yes: true, confirm: async () => true })).rejects.toThrow(/edited after it was filed/);
    expect(edited.calls.some((c) => c[1] === "create")).toBe(false);

    const closed = setup({ state: "CLOSED" });
    await expect(promotePitch(closed.runner, closed.ledger, { ...closed.base, yes: true, confirm: async () => true })).rejects.toThrow(/not open/);
    const unlabelled = setup({ labels: ["bug"] });
    await expect(promotePitch(unlabelled.runner, unlabelled.ledger, { ...unlabelled.base, yes: true, confirm: async () => true })).rejects.toThrow(/agent-pitch/);
    const unknown = setup();
    await expect(promotePitch(unknown.runner, unknown.ledger, { ...unknown.base, issue: 41, yes: true, confirm: async () => true })).rejects.toThrow(/not a pitch/);
    const declined = setup({ status: "declined" });
    await expect(promotePitch(declined.runner, declined.ledger, { ...declined.base, yes: true, confirm: async () => true })).rejects.toThrow(/already declined/);
    const old = setup({ noJson: true });
    await expect(promotePitch(old.runner, old.ledger, { ...old.base, yes: true, confirm: async () => true })).rejects.toThrow(SyntaxError); // no special-case message for rows without text: they simply do not parse
  });

  it("a failure after the first issue was created marks the pitch promoted and names what exists, so a rerun cannot duplicate it", async () => {
    const { ledger, calls, base } = setup();
    let creates = 0;
    const flaky: OnboardRunner = {
      async run(_cmd, args) {
        calls.push(args);
        if (args[0] === "issue" && args[1] === "view") return JSON.stringify({ title: PITCH.title, body: BODY, state: "OPEN", labels: [{ name: "agent-pitch" }] });
        if (args[0] === "issue" && args[1] === "create") {
          if (++creates === 2) throw new Error("gh: network down");
          return "https://github.com/acme/app/issues/100\n";
        }
        return "";
      },
    };
    await expect(promotePitch(flaky, ledger, { ...base, yes: true, confirm: async () => true })).rejects.toThrow(/#100.*network down|network down.*#100/s);
    expect(ledger.getPitch(40)!.status).toBe("promoted");
    expect(ledger.listAudit({ topicPrefix: "pitch/promoted" })).toHaveLength(1);
    expect(ledger.getPitch(40)!.promotedSlices).toEqual([0]);
    // a rerun promotes only the remaining slice instead of creating #100 again
    const rerun = await promotePitch(flaky, ledger, { ...base, yes: true, confirm: async () => true });
    expect(rerun).toHaveLength(1);
    expect(calls.filter((c) => c[1] === "create").map((c) => c[c.indexOf("--title") + 1])).toEqual(["Delete legacy parser", "Drop its tests", "Drop its tests"]);
    await expect(promotePitch(flaky, ledger, { ...base, yes: true, confirm: async () => true })).rejects.toThrow(/Every slice .* already promoted/);
  });

  it("a promoted pitch counts toward the pause rule (the Scout does not pause after it)", async () => {
    const { ledger, runner, base } = setup();
    for (let n = 1; n <= 3; n++) ledger.recordPitch({ issueNumber: n, scoutName: "pitch", trustHash: "h", title: `t${n} title long`, titleFp: `f${n}`, contentSha256: "c", pitchJson: "{}", now: n });
    await promotePitch(runner, ledger, { ...base, yes: true, confirm: async () => true });
    expect(ledger.isPitchScoutPaused("pitch", "h", 4)).toBe(false);
  });
});

describe("no compatibility path for pitches without stored text", () => {
  it("requires the pitch text when a pitch is recorded", () => {
    const ledger = new Ledger(":memory:", { repo: "acme/app" });
    // @ts-expect-error pitchJson is required: there is no "older build" shape to tolerate.
    void (() => ledger.recordPitch({ issueNumber: 1, scoutName: "p", trustHash: "h", title: "t", titleFp: "f", contentSha256: "c" }));
    ledger.close();
  });
});

describe("promoting slices one at a time", () => {
  const confirmed = <T extends object>(base: T) => ({ ...base, yes: true, confirm: async () => true });

  it("--slice marks only that slice, leaves the pitch open for the rest, and closes it once every slice is promoted", async () => {
    const { ledger, runner, calls, base } = setup();
    expect(await promotePitch(runner, ledger, { ...confirmed(base), slice: 2 })).toEqual([100]);
    expect(ledger.getPitch(40)).toMatchObject({ status: "promoted", promotedSlices: [1] });
    expect(calls.some((c) => c[1] === "close")).toBe(false); // still open: slice 1 is promotable
    const comment = calls.find((c) => c[0] === "issue" && c[1] === "comment")!;
    expect(comment[comment.indexOf("--body") + 1]).toContain("Slice 2 promoted");

    expect(await promotePitch(runner, ledger, { ...confirmed(base), slice: 1 })).toEqual([101]);
    expect(ledger.getPitch(40)!.promotedSlices).toEqual([0, 1]);
    expect(calls.filter((c) => c[1] === "close")).toHaveLength(1);
  });

  it("refuses a slice that is already promoted, and defaults to the slices not yet promoted", async () => {
    const { ledger, runner, calls, base } = setup();
    await promotePitch(runner, ledger, { ...confirmed(base), slice: 1 });
    await expect(promotePitch(runner, ledger, { ...confirmed(base), slice: 1 })).rejects.toThrow(/Slice 1 .* already promoted/);
    const rest = await promotePitch(runner, ledger, confirmed(base));
    expect(rest).toHaveLength(1);
    const titles = calls.filter((c) => c[1] === "create").map((c) => c[c.indexOf("--title") + 1]);
    expect(titles).toEqual(["Delete legacy parser", "Drop its tests"]);
  });

  it("counts as promoted for the pause rule as soon as any slice is promoted", async () => {
    const { ledger, runner, base } = setup();
    for (let n = 1; n <= 3; n++) ledger.recordPitch({ issueNumber: n, scoutName: "pitch", trustHash: "h", title: `t${n} title long`, titleFp: `f${n}`, contentSha256: "c", pitchJson: "{}", now: n });
    await promotePitch(runner, ledger, { ...confirmed(base), slice: 2 });
    expect(ledger.isPitchScoutPaused("pitch", "h", 4)).toBe(false);
  });
});
