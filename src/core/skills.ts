import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Bundled skills ship with Archangel (host-trusted), never with the target repo. */
export const SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skills");

/** `<folder>/<name>` or `<folder>/*`, lowercase slugs only (no path traversal). */
export const SKILL_REF_RE = /^[a-z0-9][a-z0-9-]*\/(\*|[a-z0-9][a-z0-9-]*)$/;

export interface Skill {
  ref: string;
  content: string;
}

/**
 * Resolves skill references to their Markdown content, in the order given, without duplicates.
 * Unknown skills or empty folders throw: a typo must not silently run a weaker Scout.
 */
export function resolveSkills(refs: string[], skillsDir = SKILLS_DIR): Skill[] {
  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!SKILL_REF_RE.test(ref)) throw new Error(`Invalid skill reference '${ref}'`);
    const [folder, name] = ref.split("/") as [string, string];
    const names =
      name === "*"
        ? listSkillNames(skillsDir, folder)
        : [name];
    if (names.length === 0) throw new Error(`Skill folder '${folder}' has no skills`);
    for (const n of names) {
      const id = `${folder}/${n}`;
      if (seen.has(id)) continue;
      const file = path.join(skillsDir, folder, `${n}.md`);
      if (!fs.existsSync(file)) throw new Error(`Unknown skill '${id}'`);
      seen.add(id);
      out.push({ ref: id, content: fs.readFileSync(file, "utf8").trim() });
    }
  }
  return out;
}

export function listSkillNames(skillsDir: string, folder: string): string[] {
  const dir = path.join(skillsDir, folder);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function listAllSkills(skillsDir = SKILLS_DIR): string[] {
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => listSkillNames(skillsDir, d.name).map((n) => `${d.name}/${n}`))
    .sort();
}
