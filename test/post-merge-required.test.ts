import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/store.js";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("merges always record which main checks to watch", () => {
  it("refuses to record an autonomous merge with no required main checks", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    l.upsertThread({ issueNumber: 1, title: "t", bodySha256: "b", now: 1 });
    expect(() => l.recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h", squashSha: "s", shadowOnly: false, now: 1 })).toThrow(/mainRequired/);
    expect(() => l.recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h", squashSha: "s", shadowOnly: false, mainRequired: [], now: 1 })).toThrow(/mainRequired/);
    expect(l.recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h", squashSha: "s", shadowOnly: false, mainRequired: ["Test"], now: 1 }).mainRequired).toEqual(["Test"]);
    // shadow verdicts watch nothing
    expect(l.recordMerge({ issueNumber: 1, prNumber: 1, headSha: "h2", shadowOnly: true, now: 1 }).mainRequired).toEqual([]);
  });

});
