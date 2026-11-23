import { Button, Flex, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import type { EvalsState, RunSummary } from "../../src/core/eval-reports.js";
import type { Feed } from "./AppView";
import { age } from "./common";
import { Badge } from "./arc/badge/badge";
import { Skeleton } from "./arc/skeleton/skeleton";
import { CopyCommand, Row, RowList, Section } from "./page";
import { ReadError } from "./HealthPage";

export const EVAL_CMD = "archangel eval run --candidate <patch>";

function describe(r: RunSummary): { title: string; meta: string; verdict: ReactNode } {
  if (r.unreadable) return { title: r.file, meta: `Unreadable: ${r.error}`, verdict: <Badge size="sm" tone="warning" dot>Unreadable</Badge> };
  const verdict =
    r.verdict === "pass" ? (
      <Badge size="sm" tone="success" dot>Passed</Badge>
    ) : r.verdict === "INSUFFICIENT DATA" ? (
      <Badge size="sm">Not enough data</Badge>
    ) : (
      <Badge size="sm" tone="warning" dot>Failed</Badge>
    );
  if (r.kind === "eval") {
    const next = r.milestone.next === null ? " (all milestones reached)" : `, ${r.milestone.next - r.milestone.current} to the next milestone (${r.milestone.next})`;
    return {
      title: `Eval, candidate ${r.candidate}`,
      meta: `${r.split} set: ${r.scored} cases scored, ${r.newFalseApprovals} new false approvals, ${r.newFalseVetoes} new false vetoes. Vault ${r.milestone.current} cases${next}.${r.reasons.length > 0 ? ` ${r.reasons.join("; ")}` : ""}`,
      verdict,
    };
  }
  if (r.kind === "bench-tiers") return { title: `Tier benchmark, ${r.role}: ${r.candidate} vs ${r.current}`, meta: r.verdictLine, verdict };
  return { title: `Replay, ${r.repos.join(", ")}`, meta: `${r.replayed} cases replayed, ${r.regressions} regressions, ${r.mutants} seeded corruptions`, verdict };
}

/** Read-only list of the last reports the CLI saved. Running an eval stays on the command line. */
export function EvalsSection({ evals, now, onRetry }: { evals: Feed<EvalsState>; now: number; onRetry: () => void }) {
  return (
    <Section gap="2">
      <Text textStyle="rowTitle" color="fg">Evals and replays</Text>
      <Text textStyle="meta" color="fg.muted">The last reports the command line saved. Running an eval stays on the command line.</Text>
      {evals.data === null ? (
        evals.error ? (
          <ReadError title="Reports unavailable.">
            <Text textStyle="meta" color="fg.muted">{evals.error}</Text>
            <Button size="xs" variant="outline" borderRadius="10px" mt="2" onClick={onRetry}>Retry</Button>
          </ReadError>
        ) : (
          <Skeleton label="Loading reports" lines={2} />
        )
      ) : (
        <>
          {evals.error ? <Text textStyle="meta" color="owner">Refresh failed ({evals.error}); showing the last loaded copy.</Text> : null}
          {evals.data.runs.length === 0 ? (
            <Flex direction="column" gap="2">
              <Text textStyle="meta" color="fg.muted">No eval runs yet.</Text>
              <CopyCommand command={EVAL_CMD} />
            </Flex>
          ) : (
            <RowList aria-label="Runs, newest first">
              {evals.data.runs.map((r) => {
                const d = describe(r);
                return <Row key={r.file} lead={age(now - r.savedAt)} title={d.title} meta={<span title={d.meta}>{d.meta}</span>} action={d.verdict} />;
              })}
            </RowList>
          )}
        </>
      )}
    </Section>
  );
}
