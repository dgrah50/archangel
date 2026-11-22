import { formatAge, STAGES, type Stage, type UiItem } from "./ui-state.js";

/**
 * Text for `archangel status`: Threads grouped by stage, in dashboard order, empty groups skipped.
 * "Needs you" is skipped here because the command prints it first, with class and recommendation.
 */
export function renderStages(stages: Record<Stage, UiItem[]>, now: number): string[] {
  const lines: string[] = [];
  for (const stage of STAGES) {
    if (stage === "Needs you") continue;
    const items = stages[stage];
    if (items.length === 0) continue;
    lines.push(`${stage} (${items.length}):`);
    for (const i of items) {
      const pr = i.prNumber ? `PR #${i.prNumber}` : "no PR";
      lines.push(`  ${i.repo}#${i.issueNumber}  [${i.phase}, ${formatAge(now - i.since)}]  ${pr}  ${i.title}`);
    }
    lines.push("");
  }
  return lines;
}
