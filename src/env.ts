import fs from "node:fs";
import path from "node:path";

/**
 * Zero-dependency `.env` loader: parses KEY=VALUE lines, supports single/double quotes
 * and `\n` escapes inside double quotes, and never overrides already-set `process.env` values.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = stripped.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
      val = val.slice(1, -1);
    } else {
      const hashIdx = val.indexOf(" #");
      if (hashIdx >= 0) val = val.slice(0, hashIdx).trim();
    }
    out[key] = val;
  }
  return out;
}

export function loadDotEnv(envPath = ".env", targetEnv: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = path.resolve(envPath);
  if (!fs.existsSync(resolved)) return false;
  const parsed = parseDotEnv(fs.readFileSync(resolved, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (targetEnv[k] === undefined) {
      targetEnv[k] = v;
    }
  }
  return true;
}
