import { REPO_SLUG_RE } from "../config.js";
import { tryParseJson } from "./json.js";
import type { OnboardRunner } from "./onboard.js";
import { ProposeRefusal } from "./ui-propose.js";

/**
 * R-gh: read-only GitHub reads with the owner's `gh` for the setup wizard. Every command is a fixed argv (GET only, no
 * `-X`, `-f`, `-F`); request values are validated first. A failed read is a 502 carrying gh's message, never a default.
 * Successful reads are cached for 30 s; failures are not.
 */
export const GH_CACHE_MS = 30_000;
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

export type GhRead = "repos" | "user" | "pr" | "protection";

export function makeGhReads(deps: { runner: OnboardRunner; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; value: unknown }>();

  async function gh(args: string[]): Promise<unknown> {
    const key = args.join("\0");
    const hit = cache.get(key);
    if (hit && now() - hit.at < GH_CACHE_MS) return hit.value;
    let out: string;
    try {
      out = await deps.runner.run("gh", args);
    } catch (err) {
      throw new ProposeRefusal(502, `gh ${args.slice(0, 2).join(" ")} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = tryParseJson(out);
    if (!parsed.ok) {
      throw new ProposeRefusal(502, `gh ${args.slice(0, 2).join(" ")} returned non-JSON output`);
    }
    const value = parsed.value;
    cache.set(key, { at: now(), value });
    return value;
  }

  const repoOf = (q: URLSearchParams): string => {
    const repo = q.get("repo") ?? "";
    if (!REPO_SLUG_RE.test(repo)) throw new ProposeRefusal(400, "repo must be owner/name");
    return repo;
  };

  return async (read: GhRead, q: URLSearchParams): Promise<unknown> => {
    switch (read) {
      case "repos":
        return gh(["repo", "list", "--limit", "100", "--json", "nameWithOwner,defaultBranchRef,isArchived,isPrivate,viewerPermission"]);
      case "user":
        return gh(["api", "user", "--jq", "{id: .id, login: .login}"]);
      case "pr": {
        const repo = repoOf(q);
        // A PR is named by number, or by head branch (the wizard looks up `chore/archangel-onboard` after a reload).
        const branch = q.get("branch");
        let selector: string;
        if (branch !== null) {
          if (!BRANCH_RE.test(branch) || branch.includes("..")) throw new ProposeRefusal(400, "branch is not a valid branch name");
          selector = branch;
        } else {
          const n = Number(q.get("number"));
          if (!Number.isSafeInteger(n) || n < 1) throw new ProposeRefusal(400, "number must be a positive integer");
          selector = String(n);
        }
        return gh(["pr", "view", selector, "--repo", repo, "--json", "number,state,isDraft,mergeable,reviewDecision,url,title,headRefName,statusCheckRollup"]);
      }
      case "protection": {
        const repo = repoOf(q);
        const branch = q.get("branch") ?? "";
        if (!BRANCH_RE.test(branch) || branch.includes("..")) throw new ProposeRefusal(400, "branch is not a valid branch name");
        return gh(["api", `repos/${repo}/branches/${branch}/protection`]);
      }
    }
  };
}
