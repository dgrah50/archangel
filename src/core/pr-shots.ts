import fs from "node:fs";
import { z } from "zod";
import { screenshotUrl } from "../compute/browser-shots.js";
import type { ComputeProvider } from "../compute/provider.js";
import { ASSETS_REF, type GitHubClient } from "../github/client.js";
import type { Ledger } from "../ledger/store.js";
import { assetPath, ingestImage } from "./pitch-ingest.js";
import { installPreviewDeps, shotPaths, type WebPreview } from "./pitch-preview.js";

/**
 * Small screenshots for GitHub. Each PNG is re-encoded by the host (at most 800 px wide, metadata gone), pushed by the App to the
 * dedicated `archangel/assets` branch, and embedded by a commit-pinned blob URL that the host builds from a number, a hash and a
 * commit sha. No model text and no URL from a page ever reaches a URL here.
 */

export const GITHUB_SHOT_WIDTH = 800;
const PR_SHOTS = 2;
const PR_SHOT_TTL_MS = 5 * 60_000;

const ShotPage = z.string().max(100).regex(/^\/([\w.-]+\/)*[\w.-]*$/);
export const ShotLinkSchema = z
  .object({
    page: ShotPage,
    url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[0-9a-f]{40}\/(prs|pitches)\/\d{1,9}\/[0-9a-f]{64}\.png\?raw=true$/),
  })
  .strict();
export type ShotLink = z.infer<typeof ShotLinkSchema>;

/** Re-encodes each PNG small, publishes them in one commit on the assets branch, and returns their pinned URLs. */
export async function publishShots(
  github: Pick<GitHubClient, "publishAssets">,
  repoSlug: string,
  dataDir: string,
  area: "prs" | "pitches",
  id: number,
  pngs: Array<{ page: string; png: Buffer }>,
): Promise<ShotLink[]> {
  const files = new Map<string, { page: string; path: string; bytes: Buffer }>();
  for (const { page, png } of pngs) {
    const img = await ingestImage(png, dataDir, { maxWidth: GITHUB_SHOT_WIDTH });
    if (img.mime !== "image/png") throw new Error("a screenshot was not re-encoded as PNG");
    files.set(img.sha256, { page, path: `${area}/${id}/${img.sha256}.png`, bytes: fs.readFileSync(assetPath(dataDir, img.sha256, img.mime)) });
  }
  const { commitSha } = await github.publishAssets({ ref: ASSETS_REF, files: [...files.values()].map((f) => ({ path: f.path, bytes: f.bytes })), message: `Screenshots for ${area} ${id}` });
  return [...files.values()].map((f) => ({ page: f.page, url: `https://github.com/${repoSlug}/blob/${commitSha}/${f.path}?raw=true` }));
}

/** Small `<img>` tags (width 400), for a Recap or a comment. Only validated links are rendered. */
export function renderShotImages(links: ShotLink[]): string {
  return links.map((l) => `<img src="${ShotLinkSchema.parse(l).url}" width="400" alt="Screenshot of ${l.page}, taken by Archangel">`).join("\n");
}

const key = (repo: string, pr: number) => `pr-shots:${repo}#${pr}`;
const StoredSchema = z.object({ headSha: z.string(), links: z.array(ShotLinkSchema) }).strict();

/** The links for this head, or null when none were attempted yet. An attempt that produced nothing is `[]`: it is not retried. */
export function getPrShots(ledger: Ledger, pr: number, headSha: string): ShotLink[] | null {
  const raw = ledger.getSystemState(key(ledger.repo, pr));
  const stored = raw ? StoredSchema.safeParse(JSON.parse(raw)) : null;
  return stored?.success && stored.data.headSha === headSha ? stored.data.links : null;
}

export function setPrShots(ledger: Ledger, pr: number, headSha: string, links: ShotLink[], now: number): void {
  ledger.setSystemState(key(ledger.repo, pr), JSON.stringify({ headSha, links }), now);
}

export interface PrShotDeps {
  github: Pick<GitHubClient, "publishAssets">;
  repoSlug: string;
  /** Prepares the clone of the PR head. */
  local: Pick<ComputeProvider, "prepare" | "destroy">;
  /** Installs and runs the app. Must be a sandboxing provider. */
  sandbox: ComputeProvider;
  preview: WebPreview;
  dataDir: string;
  installTimeoutMs: number;
  screenshot?: (url: string) => Promise<Buffer>;
}

/** Previews the PR head in the sandbox, takes 1 to 2 shots, stops it, and publishes them. Everything is torn down before it returns. */
export async function capturePrShots(deps: PrShotDeps, input: { issueNumber: number; prNumber: number; headSha: string }): Promise<ShotLink[]> {
  const ws = await deps.local.prepare({ issueNumber: input.issueNumber, startSha: input.headSha });
  try {
    await installPreviewDeps(deps.sandbox, ws, deps.preview, deps.installTimeoutMs);
    const [cmd, ...args] = deps.preview.start;
    const exposed = await deps.sandbox.expose(ws, { port: deps.preview.port, ttlMs: PR_SHOT_TTL_MS, cmd: cmd!, args, readyPath: deps.preview.readyPath });
    try {
      const shoot = deps.screenshot ?? screenshotUrl;
      const pngs: Array<{ page: string; png: Buffer }> = [];
      for (const page of shotPaths(deps.preview).slice(0, PR_SHOTS)) pngs.push({ page, png: await shoot(`${exposed.url}${page}`) });
      return await publishShots(deps.github, deps.repoSlug, deps.dataDir, "prs", input.prNumber, pngs);
    } finally {
      exposed.close();
      await exposed.closed;
    }
  } finally {
    deps.local.destroy(ws);
  }
}
