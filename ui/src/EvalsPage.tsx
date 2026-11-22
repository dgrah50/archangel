import { Button, Flex, Text } from "@chakra-ui/react";
import type { EvalsState, RunSummary } from "../../src/core/eval-reports.js";
import type { Feed } from "./AppView";
import { age } from "./common";
import { CopyCommand, Row, RowList, Section } from "./page";
import { ReadError } from "./HealthPage";

export const EVAL_CMD = "archangel eval run --candidate <patch>";

function describe(r: RunSummary): { title: string; meta: string; owed: boolean } {
  if (r.unreadable) return { title: r.file, meta: `Unreadable: ${r.error}`, owed: true };
  const owed = r.verdict !== "pass";
  const verdict = r.verdict === "INSUFFICIENT DATA" ? "Not enough data" : r.verdict === "pass" ? "Passed" : "Failed";
  if (r.kind === "eval") {
    const next = r.milestone.next === null ? " (all milestones reached)" : `, ${r.milestone.next - r.milestone.current} to the next milestone (${r.milestone.next})`;
    return {
      title: `Eval, candidate ${r.candidate}`,
      meta: `${verdict}. ${r.split} set: ${r.scored} cases scored, ${r.newFalseApprovals} new false approvals, ${r.newFalseVetoes} new false vetoes. Vault ${r.milestone.current} cases${next}.${r.reasons.length > 0 ? ` ${r.reasons.join("; ")}` : ""}`,
      owed,
    };
  }
  if (r.kind === "bench-tiers") return { title: `Tier benchmark, ${r.role}: ${r.candidate} vs ${r.current}`, meta: `${verdict}. ${r.verdictLine}`, owed };
  return { title: `Replay, ${r.repos.join(", ")}`, meta: `${verdict}. ${r.replayed} cases replayed, ${r.regressions} regressions, ${r.mutants} seeded corruptions`, owed };
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
          <Text textStyle="meta" color="fg.muted">Loading reports...</Text>
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
                return <Row key={r.file} lead={age(now - r.savedAt)} owed={d.owed} title={d.title} meta={<span title={d.meta}>{d.meta}</span>} />;
              })}
            </RowList>
          )}
        </>
      )}
    </Section>
  );
}
