import fs from "node:fs";
import path from "node:path";

/**
 * Opt-in JUnit test-ID diffing for the Gate (`gate.junitReport`). Pure parsing and attribution; the Gate decides what to do with it.
 *
 * Attribution: a test case belongs to a NEW test file F when, after normalising paths:
 *  - its `file` attribute equals F or ends with `/F` (gotestsum with file attrs, jest-junit, pytest);
 *  - its `classname` (or, if empty, the enclosing `<testsuite name>`) equals F or ends with `/F`, or F ends with `/<that path>` when it
 *    looks like a file name (Vitest and Playwright put the file path in `classname`);
 *  - Go: F is `<dir>/x_test.go` and the classname (an import path, as gotestsum writes it) equals `<dir>` or ends with `/<dir>`.
 *    This is package granularity: any test in that package attributes to the new file.
 * Dotted Java-style class names are not supported. A case that matches none of these is unattributable.
 *
 * Threat model: the report is written by the repo's own test command, which is PR-controlled on the head side, so this guards against
 * honest noise (flaky or environment failures), not against a PR that forges its own report; the same author could `exit 1` just as easily.
 */

export interface JunitCase {
  id: string;
  classname: string;
  name: string;
  file: string | null;
  status: "passed" | "failed" | "skipped";
}

const MAX_REPORT_BYTES = 10 * 1024 * 1024;
const MAX_WALK_ENTRIES = 50_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);

function decode(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = decode(m[2] ?? m[3] ?? "");
  return out;
}

/** Returns the test cases, or null when the document is not a usable JUnit report (fail closed). */
export function parseJunit(xml: string): JunitCase[] | null {
  const cleaned = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  if (!/<testsuites?\b/.test(cleaned)) return null;
  const suites = [...cleaned.matchAll(/<testsuite\b([^>]*)>/g)].map((m) => ({ at: m.index!, name: attrs(m[1]!).name ?? "" }));
  const opened = [...cleaned.matchAll(/<testcase\b/g)].length;
  const cases: JunitCase[] = [];
  for (const m of cleaned.matchAll(/<testcase\b([^>]*?)(\/?)>/g)) {
    const a = attrs(m[1]!);
    let body = "";
    if (m[2] !== "/") {
      const end = cleaned.indexOf("</testcase>", m.index! + m[0].length);
      if (end === -1) return null;
      body = cleaned.slice(m.index! + m[0].length, end);
    }
    const suite = [...suites].reverse().find((s) => s.at < m.index!)?.name ?? "";
    const classname = a.classname || suite;
    const name = a.name ?? "";
    cases.push({
      id: `${classname}::${name}`.slice(0, 200),
      classname,
      name,
      file: a.file ?? null,
      status: /<(?:failure|error)\b/.test(body) ? "failed" : /<skipped\b/.test(body) ? "skipped" : "passed",
    });
  }
  return cases.length === opened ? cases : null;
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

export function attributableTo(c: JunitCase, newTestFiles: readonly string[]): boolean {
  for (const f of newTestFiles.map(norm)) {
    for (const cand of [c.file, c.classname]) {
      if (!cand) continue;
      const n = norm(cand);
      if (n === f || n.endsWith(`/${f}`)) return true;
      if (n.includes("/") && /\.[A-Za-z0-9]+$/.test(n) && f.endsWith(`/${n}`)) return true; // a path relative to a deeper root; bare names are ambiguous
    }
    if (f.endsWith("_test.go")) {
      const dir = path.posix.dirname(f);
      if (dir !== "." && (c.classname === dir || c.classname.endsWith(`/${dir}`))) return true;
    }
  }
  return false;
}

function walk(dir: string, re: RegExp, out: string[], budget: { n: number }, rel = ""): void {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (budget.n-- <= 0) return;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(dir, re, out, budget, r);
    } else if (e.isFile() && re.test(r)) {
      out.push(r);
    }
  }
}

export function findReportFiles(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  walk(dir, re, out, { n: MAX_WALK_ENTRIES });
  return out.sort();
}

/** Removes any report already present (a committed or stale one) so only what this test run wrote is read. */
export function clearReports(dir: string, re: RegExp): void {
  for (const r of findReportFiles(dir, re)) fs.rmSync(path.join(dir, r), { force: true });
}

export function readReports(dir: string, re: RegExp): { cases: JunitCase[] } | { error: string } {
  const files = findReportFiles(dir, re);
  if (files.length === 0) return { error: "no JUnit report was produced at the configured junitReport path" };
  const cases: JunitCase[] = [];
  for (const r of files) {
    const full = path.join(dir, r);
    if (fs.statSync(full).size > MAX_REPORT_BYTES) return { error: `JUnit report ${r} is larger than ${MAX_REPORT_BYTES} bytes` };
    const parsed = parseJunit(fs.readFileSync(full, "utf8"));
    if (parsed === null) return { error: `JUnit report ${r} is not parseable` };
    cases.push(...parsed);
  }
  return { cases };
}

export function capIds(ids: readonly string[]): string[] {
  return ids.slice(0, 20).map((s) => s.slice(0, 160));
}
