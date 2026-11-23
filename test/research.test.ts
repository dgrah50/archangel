import { describe, expect, it } from "bun:test";
import { checkPitch, PitchOutputSchema, renderPitchBody } from "../src/core/pitch.js";
import { RESEARCH_TEMPLATES, buildQueries, buildResearchBlock, citableResearch, fetchResearch, pickTemplates } from "../src/core/research.js";
import { ResearchConfigSchema } from "../src/config.js";
import { Ledger } from "../src/ledger/store.js";
import { FakeGitHub } from "./helpers/fake-github.js";

const NOW = 200 * 86_400_000;
const cfg = ResearchConfigSchema.parse({ topics: ["json query cli", "jsonpath"], minIntervalMs: 1000, maxFetchesPerDay: 100 });
const sleep = async () => {};

describe("research fetcher", () => {
  it("builds every query from owner topics x fixed templates, and a template can only be picked by index", async () => {
    expect(buildQueries(cfg.topics)).toHaveLength(cfg.topics.length * RESEARCH_TEMPLATES.length);
    expect(() => pickTemplates(buildQueries(cfg.topics), [1, "json; rm -rf"])).toThrow();
    expect(() => pickTemplates(buildQueries(cfg.topics), [RESEARCH_TEMPLATES.length])).toThrow();

    const seen: string[] = [];
    const github = {
      searchRepositories: async (q: string) => (seen.push(q), []),
      getLatestRelease: async () => null,
    };
    const ledger = new Ledger(":memory:", { repo: "o/r" });
    await fetchResearch({ ledger, github, cfg, now: NOW, sleep, fetchArxiv: async (url) => (seen.push(decodeURIComponent(url)), "") });
    const allowed = new Set(buildQueries(cfg.topics).map((q) => q.text));
    expect(seen.length).toBeGreaterThan(0);
    for (const q of seen) expect([...allowed].some((a) => q === a || q.includes(`all:${a}&`))).toBe(true);
  });

  it("stores a capped, sanitized snippet and drops a result that carries a secret", async () => {
    const github = new FakeGitHub("unused");
    github.searchResults = [
      { fullName: "a/clean", url: "https://github.com/a/clean?utm=1#x", pushedAt: "2026-11-01T00:00:00Z", description: `<b>Fast</b> [click](https://evil.example/x) ${"word ".repeat(200)}` },
      { fullName: "a/leaky", url: "https://github.com/a/leaky", pushedAt: "2026-11-01T00:00:00Z", description: "key ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      { fullName: "a/offsite", url: "https://evil.example/a", pushedAt: "2026-11-01T00:00:00Z", description: "x" },
    ];
    const ledger = new Ledger(":memory:", { repo: "o/r" });
    await fetchResearch({ ledger, github, cfg: ResearchConfigSchema.parse({ topics: ["jq"], minIntervalMs: 1000 }), now: NOW, sleep }, [0]);
    const rows = ledger.listResearchResults(0, 10);
    expect(rows.map((r) => r.url)).toEqual(["https://github.com/a/clean"]);
    expect(rows[0]!.snippet.length).toBeLessThanOrEqual(300);
    expect(rows[0]!.snippet).not.toMatch(/[<>[\]]|http|evil/);
  });

  it("cites by index only: links come from stored rows and an index outside the block is dropped", async () => {
    const ledger = new Ledger(":memory:", { repo: "o/r" });
    ledger.insertResearchResult({ source: "arxiv", template: 3, topic: "jq", title: "Fast JSON paths", url: "https://arxiv.org/abs/2401.00001", date: "2026-11-01", snippet: "s", fetchedAt: NOW });
    const rows = citableResearch(ledger, NOW);
    expect(buildResearchBlock(rows)).not.toContain("arxiv.org");

    const ev = (research: number | null) => ({ file: research === null ? "app.ts" : null, symbol: research === null ? "parseFast" : null, metric: null, research, watched: null, note: "see https://evil.example/x" });
    const pitch = PitchOutputSchema.parse({
      pitches: [
        {
          type: "feature", title: "Adopt the fast path idea", problem: "p", evidence: [ev(1), ev(null)], proposal: "x", smallestVersion: "y",
          optionsConsidered: ["Do nothing", "Adopt"], slices: [{ title: "t", acceptance: "a" }], measurement: "", figures: [], changeDiagram: null, estimates: [],
          recommendation: "do", size: "S",
        },
      ],
    }).pitches[0]!;
    const body = renderPitchBody(pitch, { repo: "o/r", mainSha: "m" }, rows);
    expect(body).toContain("- [1] Fast JSON paths (2026-11-01), https://arxiv.org/abs/2401.00001");

    const ctx = { fileExists: async () => true, ingestFigure: async () => { throw new Error("none"); }, source: { repo: "o/r", mainSha: "m" }, metricsGiven: new Set<string>(), secretScan: () => null, isDuplicate: () => false, watchedGiven: new Set<string>(), fileContains: async () => true };
    expect(await checkPitch(pitch, { ...ctx, researchGiven: 1, research: rows })).toBeNull();
    expect(await checkPitch(pitch, { ...ctx, researchGiven: 0, research: [] })).toContain("research [1]");
    // The hard rule: an external pattern with no real hit in our own code (no cited symbol in a cited file) is dropped.
    expect(await checkPitch(pitch, { ...ctx, researchGiven: 1, research: rows, fileContains: async () => false })).toContain("proof of life");
  });
});
