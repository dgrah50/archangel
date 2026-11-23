import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolvePaths } from "../config.js";
import { ARCHANGEL_ROOT } from "../core/onboard.js";
import { Ledger } from "../ledger/store.js";

const OWNER_TODO = "ownerUserId: 0  # TODO: your numeric GitHub user id; run `gh auth login`, then `gh api user --jq .id`";

/** The owner's numeric GitHub id from their own `gh`, or null when gh is missing or not logged in. Never guessed. */
export function ghUserId(): number | null {
  try {
    const id = Number(execFileSync("gh", ["api", "user", "--jq", ".id"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch (err) {
    // gh missing (ENOENT) or not logged in (non-zero exit): no id. Anything else is a real failure.
    const e = err as NodeJS.ErrnoException & { status?: number };
    if (e.code === "ENOENT" || typeof e.status === "number") return null;
    throw err;
  }
}

/** A single-project starter: the example config without the multi-account, fleet-Scout and Paseo sections. */
export function starterYaml(example: string, ownerId: number | null): string {
  const drop = [/^# Subscription accounts[\s\S]*?^#   - \{ id: agy-b.*\n/m, /^# Bundled fleet Scouts[\s\S]*?^# fleetMinerSeeds.*\n\n?/m, /^# Optional Paseo daemon[\s\S]*?^paseoHost:.*\n\n?/m];
  let out = drop.reduce((text, re) => text.replace(re, ""), example);
  out = out.replace(/^ownerUserId:.*$/m, ownerId ? `ownerUserId: ${ownerId}` : OWNER_TODO);
  return out.replace(/^  - repo: owner\/my-repo$/m, "  - repo: owner/my-repo   # TODO: your repo; `archangel onboard owner/name` checks it");
}

/** Idempotent setup in `cwd`: archangel.yaml, .env, and an empty Ledger the dashboard can audit into. Returns the lines to print. */
export function runInit(cwd: string, opts: { ghUserId?: () => number | null } = {}): string[] {
  const lines: string[] = [];
  const yamlPath = path.join(cwd, "archangel.yaml");
  const envPath = path.join(cwd, ".env");
  const gh = opts.ghUserId ?? ghUserId;

  if (fs.existsSync(yamlPath)) lines.push("kept     archangel.yaml");
  else {
    const id = gh();
    fs.writeFileSync(yamlPath, starterYaml(fs.readFileSync(path.join(ARCHANGEL_ROOT, "archangel.example.yaml"), "utf8"), id));
    lines.push("created  archangel.yaml");
    lines.push(id ? `         ownerUserId ${id} from gh` : "         TODO ownerUserId is not set: gh is missing or not logged in. Run `gh auth login`, then `gh api user --jq .id`, and put the number in archangel.yaml.");
  }

  if (fs.existsSync(envPath)) lines.push("kept     .env");
  else {
    fs.writeFileSync(envPath, fs.readFileSync(path.join(ARCHANGEL_ROOT, ".env.example")), { mode: 0o600 });
    lines.push("created  .env (mode 0600, no values filled in)");
  }

  const raw = parseYaml(fs.readFileSync(yamlPath, "utf8")) as { dataDir?: unknown } | null;
  const dataDir = typeof raw?.dataDir === "string" ? raw.dataDir : ".archangel";
  const ledgerPath = resolvePaths({ dataDir: dataDir.startsWith("~") ? dataDir : path.resolve(cwd, dataDir) } as Parameters<typeof resolvePaths>[0]).ledgerDbPath;
  if (fs.existsSync(ledgerPath)) lines.push(`kept     Ledger ${ledgerPath}`);
  else {
    const ledger = new Ledger(ledgerPath);
    // Actor `init`, not `owner`: only owner rows reset the autonomy cap.
    try { ledger.appendAudit("init/created", null, "init", { yaml: path.basename(yamlPath) }, Date.now(), null); } finally { ledger.close(); }
    lines.push(`created  Ledger ${ledgerPath}`);
  }
  return lines;
}

export const INIT_NEXT_STEPS = [
  "bun scripts/create-github-app.ts   # creates the App and fills in the App, installation and bot ids",
  "archangel doctor",
  "archangel ui",
  "archangel daemon install",
];
