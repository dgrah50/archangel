import { describe, expect, it } from "bun:test";
import { attachCaptions, buildChapters, CAPTION_MAX_CHARS, parseDiffStat } from "../src/core/recap-chapters.js";

const diff = [
  "diff --git a/src/core/a.ts b/src/core/a.ts",
  "@@ -1,2 +1,3 @@",
  "-old",
  "+new",
  "+more",
  "diff --git a/src/gate/g.ts b/src/gate/g.ts",
  "@@ -1 +1 @@",
  "-x",
  "+y",
  "diff --git a/test/a.test.ts b/test/a.test.ts",
  "@@ -0,0 +1,2 @@",
  "+t1",
  "+t2",
  "diff --git a/README.md b/README.md",
  "@@ -1 +1,2 @@",
  "+doc",
].join("\n");

describe("recap chapters", () => {
  it("group the diff mechanically by kind and top-level directory, and sum to the diff", () => {
    const files = parseDiffStat(diff);
    const chapters = buildChapters(files, { isProtected: (p) => p.startsWith("src/gate/"), isTest: (p) => p.endsWith(".test.ts") });
    expect(chapters.map((c) => `${c.kind}:${c.area}`)).toEqual(["protected:src", "code:(root)", "code:src", "test:test"]);
    expect(chapters.flatMap((c) => c.files.map((f) => f.path)).sort()).toEqual(files.map((f) => f.path).sort());
    expect(chapters.reduce((n, c) => n + c.added, 0)).toBe(files.reduce((n, f) => n + f.added, 0));
    expect(chapters.reduce((n, c) => n + c.deleted, 0)).toBe(2);
    expect(chapters.every((c) => c.caption === undefined)).toBe(true);
  });

  it("keep a model caption only when it is capped, one line and secret-free", () => {
    const chapters = buildChapters(parseDiffStat(diff), { isProtected: () => false, isTest: (p) => p.startsWith("test/") });
    const scan = (t: string) => (t.includes("ghp_") ? "token" : null);
    const out = attachCaptions(
      chapters,
      { captions: [{ chapter: 0, caption: `${"x".repeat(500)}\nsecond line` }, { chapter: 1, caption: "leaks ghp_abc" }, { chapter: 9, caption: "no such chapter" }] },
      scan,
    );
    expect(out[0]!.caption).toHaveLength(CAPTION_MAX_CHARS);
    expect(out[1]!.caption).toBeUndefined();
    expect(attachCaptions(chapters, "garbage", scan)).toEqual(chapters);
  });
});
