import { describe, expect, it } from "bun:test";
import { lintRepo, lintSourceText } from "../scripts/lint.js";

describe("structural lint catches recurring past mistakes", () => {
  it("flags bindingless and empty catches (PRs #111, #151, #152, #164, #184)", () => {
    const bare = lintSourceText("src/x.ts", "try { foo(); } catch { return null; }");
    expect(bare.map((i) => i.rule)).toContain("no-silent-catch");
    expect(bare[0]!.message).toContain("tryParseJson");

    const empty = lintSourceText("src/x.ts", "try { foo(); } catch (err) {}");
    expect(empty.map((i) => i.rule)).toContain("no-silent-catch");

    const ok = lintSourceText("src/x.ts", "try { foo(); } catch (err) { throw err; }");
    expect(ok).toEqual([]);
  });

  it("flags fetch() without AbortSignal timeout (PR #132)", () => {
    const bad = lintSourceText("src/x.ts", "await fetch('https://api.github.com');");
    expect(bad.map((i) => i.rule)).toContain("fetch-requires-timeout");
    expect(bad[0]!.message).toContain("AbortSignal.timeout");

    const ok = lintSourceText("src/x.ts", "await fetch('https://api.github.com', { signal: AbortSignal.timeout(5000) });");
    expect(ok).toEqual([]);
  });

  it("flags raw SQL mutating state-machine columns outside their CAS method (PRs #125, #129, #211)", () => {
    const bad = lintSourceText("src/core/reconciler.ts", "db.prepare(`UPDATE threads SET phase_json = ? WHERE issue_number = ?`);");
    expect(bad.map((i) => i.rule)).toContain("no-raw-state-sql");

    const ok = lintSourceText(
      "src/ledger/store.ts",
      "class Ledger { transition() { this.db.prepare(`UPDATE threads SET phase_json = ? WHERE version = ?`); } }",
    );
    expect(ok).toEqual([]);
  });

  it("flags Date.now() inside pure state machines", () => {
    const bad = lintSourceText("src/core/thread-machine.ts", "export const x = () => Date.now();");
    expect(bad.map((i) => i.rule)).toContain("no-wall-clock-in-machines");
  });

  it("flags type escapes (as any, as never, @ts-ignore)", () => {
    const bad = lintSourceText("src/x.ts", "const a = x as any;\n// @ts-ignore\nconst b = y as never;");
    expect(bad.filter((i) => i.rule === "no-type-escape")).toHaveLength(3);
  });

  it("flags res.writeHead() called before an await in the same block (PR #120)", () => {
    const bad = lintSourceText("src/core/ui-server.ts", "async function h(res: any) { res.writeHead(200); const body = await load(); res.end(body); }");
    expect(bad.map((i) => i.rule)).toContain("no-writehead-before-await");

    const ok = lintSourceText("src/core/ui-server.ts", "async function h(res: unknown) { const body = await load(); (res as { writeHead(n: number): void; end(s: string): void }).writeHead(200); }");
    expect(ok.filter((i) => i.rule === "no-writehead-before-await")).toEqual([]);
  });

  it("passes cleanly across the entire src/ tree", () => {
    expect(lintRepo()).toEqual([]);
  });
});
