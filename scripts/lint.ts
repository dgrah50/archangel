import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface LintIssue {
  file: string;
  line: number;
  rule: string;
  message: string;
}

const RAW_STATE_SQL_PATTERNS: Array<{ re: RegExp; allowedIn: string; method: string }> = [
  { re: /\bUPDATE\s+threads\s+SET\b[\s\S]*\bphase_json\b/i, allowedIn: "src/ledger/store.ts", method: "transition" },
  { re: /\bUPDATE\s+daemon_commands\s+SET\b[\s\S]*\bstate_json\b/i, allowedIn: "src/ledger/store.ts", method: "stepCommandState" },
  { re: /\bUPDATE\s+pitches\s+SET\b[\s\S]*\bstate_json\b/i, allowedIn: "src/ledger/store.ts", method: "stepPitchState" },
];

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function enclosingMethodName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    cur = cur.parent;
  }
  return null;
}

function containsAwait(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(n)) return;
    if (ts.isAwaitExpression(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function isWriteHeadCall(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionLike(n)) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "writeHead"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export function lintSourceText(file: string, sourceText: string): LintIssue[] {
  const norm = file.replace(/\\/g, "/");
  const sf = ts.createSourceFile(norm, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const issues: LintIssue[] = [];
  const isMachineFile = /^src\/core\/.*-machine\.ts$/.test(norm);

  const lines = sourceText.split("\n");
  lines.forEach((line, idx) => {
    if (/@ts-(ignore|expect-error|nocheck)\b/.test(line)) {
      issues.push({
        file: norm,
        line: idx + 1,
        rule: "no-type-escape",
        message: "TypeScript suppression hides boundary bugs. Narrow unknown values or validate with Zod at the boundary.",
      });
    }
  });

  const visit = (node: ts.Node): void => {
    // Rule 1: no-silent-catch (guards PRs #111, #151, #152, #164, #184, #103, #87, #83)
    if (ts.isCatchClause(node)) {
      if (!node.variableDeclaration) {
        issues.push({
          file: norm,
          line: lineOf(sf, node.getStart(sf)),
          rule: "no-silent-catch",
          message:
            "Bindingless catch swallows unexpected failures. Use tryParseJson() from src/core/json.ts for JSON fallbacks, or bind (err) and handle, narrow, log, or rethrow it.",
        });
      } else if (node.block.statements.length === 0) {
        issues.push({
          file: norm,
          line: lineOf(sf, node.getStart(sf)),
          rule: "no-silent-catch",
          message:
            "Empty catch block hides failures. Handle, log, or narrow the caught error instead of discarding it.",
        });
      }
    }

    // Rule 2: fetch-requires-timeout (guards PR #132)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "fetch") {
      const init = node.arguments[1];
      let hasSignal = false;
      if (init && ts.isObjectLiteralExpression(init)) {
        hasSignal = init.properties.some(
          (p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            ts.isIdentifier(p.name) &&
            p.name.text === "signal",
        );
      }
      if (!hasSignal) {
        issues.push({
          file: norm,
          line: lineOf(sf, node.getStart(sf)),
          rule: "fetch-requires-timeout",
          message:
            "fetch() without an AbortSignal can hang the daemon tick. Pass signal: AbortSignal.timeout(...) in the options object.",
        });
      }
    }

    // Rule 3: no-raw-state-sql (guards PRs #125, #129, #140, #211)
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node) || ts.isTemplateExpression(node)) {
      const text = node.getText(sf);
      for (const spec of RAW_STATE_SQL_PATTERNS) {
        if (spec.re.test(text)) {
          const allowed = norm === spec.allowedIn && enclosingMethodName(node) === spec.method;
          if (!allowed) {
            issues.push({
              file: norm,
              line: lineOf(sf, node.getStart(sf)),
              rule: "no-raw-state-sql",
              message: `Direct SQL mutation bypasses state-machine CAS. Route updates through ${spec.method}() in ${spec.allowedIn}.`,
            });
          }
        }
      }
    }

    // Rule 4: no-wall-clock-in-machines (guards state-machine determinism)
    if (isMachineFile) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Date" &&
        node.expression.name.text === "now"
      ) {
        issues.push({
          file: norm,
          line: lineOf(sf, node.getStart(sf)),
          rule: "no-wall-clock-in-machines",
          message: "State machines must be pure and deterministic. Pass now: number on the event instead of calling Date.now().",
        });
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && (!node.arguments || node.arguments.length === 0)) {
        issues.push({
          file: norm,
          line: lineOf(sf, node.getStart(sf)),
          rule: "no-wall-clock-in-machines",
          message: "State machines must be pure and deterministic. Pass now: number on the event instead of calling new Date().",
        });
      }
    }

    // Rule 5: no-type-escape (guards PR #85 and type-level bypasses)
    if (ts.isAsExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.AnyKeyword || node.type.kind === ts.SyntaxKind.NeverKeyword) {
        issues.push({
          file: norm,
          line: lineOf(sf, node.getStart(sf)),
          rule: "no-type-escape",
          message: "Type assertion to any/never bypasses compiler checks. Narrow unknown values or validate with Zod at the boundary.",
        });
      }
    }

    // Rule 6: no-writehead-before-await (guards PR #120)
    if (ts.isBlock(node)) {
      let writeHeadLine: number | null = null;
      for (const stmt of node.statements) {
        if (writeHeadLine !== null && containsAwait(stmt)) {
          issues.push({
            file: norm,
            line: writeHeadLine,
            rule: "no-writehead-before-await",
            message:
              "Build async response bodies before calling res.writeHead() so failures can still answer 500 instead of throwing ERR_HTTP_HEADERS_SENT.",
          });
          writeHeadLine = null;
        }
        if (ts.isExpressionStatement(stmt) && isWriteHeadCall(stmt.expression)) {
          writeHeadLine = lineOf(sf, stmt.getStart(sf));
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return issues;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out.sort();
}

export function lintRepo(rootDir = process.cwd()): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const abs of walkTs(path.join(rootDir, "src"))) {
    const rel = path.relative(rootDir, abs).replace(/\\/g, "/");
    issues.push(...lintSourceText(rel, fs.readFileSync(abs, "utf8")));
  }
  return issues;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const issues = lintRepo();
  if (issues.length > 0) {
    for (const i of issues) {
      console.error(`${i.file}:${i.line} [${i.rule}] ${i.message}`);
    }
    console.error(`\nLint failed with ${issues.length} issue(s).`);
    process.exit(1);
  }
  console.log("Lint passed (0 issues across src/**/*.ts).");
}
