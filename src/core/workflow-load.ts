import { REPO_POLICY_PATH, type ArchangelConfig } from "../config.js";
import type { Ledger } from "../ledger/store.js";
import { resolveSkills } from "./skills.js";
import { resolveWorkflow, type EffectiveWorkflow, type OkWorkflow } from "./workflow.js";

export interface WorkflowFileReader {
  readFileAtRef(ref: string, relPath: string): Promise<string | null>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,48}$/;

/**
 * Reads `.agents/archangel.json` and each declared Scout's `.agents/scouts/<name>.md` body at `mainSha`
 * and resolves them against the host config. Pure resolution lives in workflow.ts; this is the only I/O.
 */
export async function loadWorkflow(
  reader: WorkflowFileReader,
  cfg: ArchangelConfig,
  ledger: Pick<Ledger, "isScoutAutoPromoteRevoked">,
  mainSha: string,
): Promise<EffectiveWorkflow> {
  const fileRaw = await reader.readFileAtRef(mainSha, REPO_POLICY_PATH);
  const scoutPrompts: Record<string, string> = {};
  if (fileRaw) {
    let names: unknown[] = [];
    try {
      const parsed = JSON.parse(fileRaw) as { scouts?: Array<{ name?: unknown }> };
      names = Array.isArray(parsed.scouts) ? parsed.scouts.map((s) => s?.name) : [];
    } catch {
      // resolveWorkflow reports the invalid JSON
    }
    for (const name of names) {
      if (typeof name !== "string" || !SLUG.test(name)) continue;
      const body = await reader.readFileAtRef(mainSha, `.agents/scouts/${name}.md`);
      if (body !== null) scoutPrompts[name] = body.trim();
    }
  }
  const resolved = resolveWorkflow(
    {
      shadowMode: cfg.shadowMode,
      maxAutoMergesPerDay: cfg.maxAutoMergesPerDay,
      maxAutoPromotionsPerDay: cfg.scouts.maxAutoPromotionsPerDay,
      scoutRunsPerDay: cfg.scouts.maxRunsPerDay,
      maxConcurrentThreads: cfg.maxConcurrentThreads,
      isRevoked: (name, hash) => ledger.isScoutAutoPromoteRevoked(name, hash),
    },
    { repo: `${cfg.githubOwner}/${cfg.githubRepo}`, mainSha, fileRaw, scoutPrompts },
  );
  if (resolved.status !== "ok") return resolved;
  // Skills live in Archangel's own `skills/` directory, so only this layer can check them. A typo must halt the repo here,
  // not later inside the Scout runner where it would break every Scout.
  for (const s of resolved.scouts) {
    try {
      resolveSkills(s.skills);
    } catch (err) {
      return { repo: resolved.repo, mainSha, status: "invalid", fileSha256: resolved.fileSha256, error: `scout '${s.name}': ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return resolved;
}

export function workflowError(wf: EffectiveWorkflow): string | null {
  return wf.status === "ok" ? null : wf.status === "missing" ? `${REPO_POLICY_PATH} is missing on the default branch` : wf.error;
}

export function requireOkWorkflow(wf: EffectiveWorkflow): OkWorkflow {
  if (wf.status !== "ok") throw new Error(`Workflow ${wf.status}: ${workflowError(wf)}`);
  return wf;
}
