import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_POLICY_PATH } from "../config.js";
import type { ReviewPromptBuilders, ReviewRequest } from "../agents/reviewers.js";
import { git } from "./replay.js";
import { Workflow } from "./workflow.js";

/**
 * A candidate change to Archangel's own review wording, applied to a throwaway checkout. Nothing here changes the working tree:
 * both the baseline (HEAD) and the candidate (HEAD plus the patch) are loaded from separate clones in the temp directory.
 */

/** The only files a candidate may touch. Anything else is code, and eval will not load or run it. */
export const CANDIDATE_ALLOWED = [/^src\/agents\/prompts\.ts$/, /^skills\/.+\.md$/, /^\.agents\/archangel\.json$/];

export interface Candidate {
  /** sha256 of the patch text (identifies the candidate in reports). */
  patchSha256: string;
  files: string[];
  /** Reviewer prompt templates from the candidate's `src/agents/prompts.ts`. */
  prompts: ReviewPromptBuilders;
  /** The candidate's review rubric when the patch changes it; applies to every case. Null leaves each case's own rubric. */
  rubricOverride: string | null;
  /** Skills and the rubric of other repos do not affect the review stage; the report says so. */
  touchesSkills: boolean;
  cleanup: () => void;
}

export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
    files.add(m[1]!);
    files.add(m[2]!);
  }
  for (const m of patch.matchAll(/^(?:---|\+\+\+) [ab]\/(\S+)$/gm)) files.add(m[1]!);
  return [...files].sort();
}

/** Bundles a checkout's `src/agents/prompts.ts` and returns its two reviewer prompt builders. */
export async function loadReviewPrompts(checkoutDir: string): Promise<ReviewPromptBuilders> {
  const entry = path.join(checkoutDir, "src/agents/prompts.ts");
  if (!fs.existsSync(entry)) throw new Error(`no src/agents/prompts.ts in ${checkoutDir}`);
  const { build } = await import("esbuild");
  const out = path.join(os.tmpdir(), `archangel-eval-prompts-${crypto.randomBytes(6).toString("hex")}.mjs`);
  try {
    await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent" });
    const mod = (await import(pathToFileURL(out).href)) as {
      buildOpenAiReviewerPrompt: (r: ReviewRequest) => string;
      buildGeminiAdversarialPrompt: (r: ReviewRequest) => string;
    };
    if (typeof mod.buildOpenAiReviewerPrompt !== "function" || typeof mod.buildGeminiAdversarialPrompt !== "function") {
      throw new Error("prompts.ts must export buildOpenAiReviewerPrompt and buildGeminiAdversarialPrompt");
    }
    return { contract: mod.buildOpenAiReviewerPrompt, adversarial: mod.buildGeminiAdversarialPrompt };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

function rubricOf(dir: string): string | null {
  const f = path.join(dir, REPO_POLICY_PATH);
  if (!fs.existsSync(f)) return null;
  const parsed = Workflow.safeParse(JSON.parse(fs.readFileSync(f, "utf8")));
  return parsed.success ? (parsed.data.review.rubric ?? null) : null;
}

/** Clones `archangelRoot` at HEAD twice (baseline and candidate), applies the patch to the second, and loads both. */
export async function prepareCandidates(
  archangelRoot: string,
  patchFile: string,
): Promise<{ baseline: { prompts: ReviewPromptBuilders }; candidate: Candidate }> {
  const patch = fs.readFileSync(patchFile, "utf8");
  const files = patchFiles(patch);
  if (files.length === 0) throw new Error(`${patchFile} contains no file changes`);
  const bad = files.filter((f) => !CANDIDATE_ALLOWED.some((re) => re.test(f)));
  if (bad.length > 0) {
    throw new Error(`a candidate may only change src/agents/prompts.ts, skills/*.md and .agents/archangel.json (refusing: ${bad.join(", ")})`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-eval-"));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  try {
    const baseDir = path.join(tmp, "baseline");
    const candDir = path.join(tmp, "candidate");
    await git(tmp, ["clone", "--no-local", "--quiet", archangelRoot, baseDir]);
    await git(tmp, ["clone", "--no-local", "--quiet", archangelRoot, candDir]);
    // A patch that does not apply cleanly is an error, never a partial candidate.
    await git(candDir, ["apply", "--check", path.resolve(patchFile)]);
    await git(candDir, ["apply", path.resolve(patchFile)]);
    const [baselinePrompts, candidatePrompts] = [await loadReviewPrompts(baseDir), await loadReviewPrompts(candDir)];
    const baseRubric = rubricOf(baseDir);
    const candRubric = rubricOf(candDir);
    return {
      baseline: { prompts: baselinePrompts },
      candidate: {
        patchSha256: crypto.createHash("sha256").update(patch).digest("hex"),
        files,
        prompts: candidatePrompts,
        rubricOverride: candRubric !== baseRubric ? candRubric : null,
        touchesSkills: files.some((f) => f.startsWith("skills/")),
        cleanup,
      },
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}
