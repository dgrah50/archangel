import { Link } from "@chakra-ui/react";
import type { ReactNode } from "react";
import type { UiItem, UiState } from "../../src/core/ui-state.js";
import { age } from "./common";
import { Badge } from "./arc/badge/badge";
import { Line, Ref, type Tone } from "./page";

import { threadHash, type ItemRef } from "./route";

// The Overview and the Threads page list Threads the same way: the same groups, names, order, dots and one-line rows.
// Strings from the Ledger (issue titles) are untrusted: only ever React text children; links only for repo slugs shaped like owner/name.

const SLUG = /^[\w.-]+\/[\w.-]+$/;

export const gap = (ms: number) => age(ms).replace(/(\d)([a-z])/, "$1 $2");
export const gh = (repo: string, kind: "issues" | "pull", num: number) => `https://github.com/${repo}/${kind}/${num}`;
export const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Phase names as the owner says them. */
const PHASE: Record<string, string> = { working: "working", awaiting_gate: "at the Gate", reviewing: "in review", landing: "landing", shadow_ready: "passed review", awaiting_plan: "plan waiting for your approval" };
export const phaseWord = (phase: string) => (phase === "queued" ? "" : (PHASE[phase] ?? phase.replace(/_/g, " ")));

/** What the factory is acting on: working, waiting on CI and in review as one group, longest-waiting first. */
export const runningOf = (groups: UiState["groups"], repo = "") => [...groups.Working, ...groups["Waiting on CI"], ...groups["In review"]].filter((i) => repo === "" || i.repo === repo).sort((a, b) => b.since - a.since);

/** A PR that links out to GitHub, as a badge. */
export function PrBadge({ repo, num }: { repo: string; num: number }) {
  return (
    <Link href={gh(repo, "pull", num)} target="_blank" rel="noreferrer noopener" flexShrink={0} textDecoration="none" _hover={{ textDecoration: "none" }}>
      <Badge outline pill>
        PR #{num}
      </Badge>
    </Link>
  );
}

/** One Thread as a line. `pr` adds its PR badge; `chip` replaces it. `selected` marks the open Thread of the Threads page. */
export function ThreadLine({ i, now, tone, meta, chip, pr, selected }: { i: UiItem; now: number; tone: Tone; meta: string; chip?: ReactNode; pr?: boolean; selected?: ItemRef | null }) {
  const ok = SLUG.test(i.repo);
  return (
    <Line
      tone={tone}
      href={ok ? threadHash({ repo: i.repo, issue: i.issueNumber }) : undefined}
      selected={selected != null && i.repo === selected.repo && i.issueNumber === selected.issue}
      title={i.title}
      meta={
        <>
          <Ref repo={i.repo} num={i.issueNumber} />
          {meta ? ` · ${meta}` : ""}
        </>
      }
      chip={chip ?? (pr && ok && i.prNumber ? <PrBadge repo={i.repo} num={i.prNumber} /> : undefined)}
      when={gap(now - i.since)}
    />
  );
}
