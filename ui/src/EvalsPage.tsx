import { Badge, Box, Button, Card, Code, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { useState } from "react";
import type { EvalsState, RunSummary } from "../../src/core/eval-reports.js";
import type { Feed } from "./AppView";
import { age } from "./common";

export const EVAL_CMD = "archangel eval run --candidate <patch>";
const TONE = { pass: "green", fail: "red", "INSUFFICIENT DATA": "orange" } as const;

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="2xs" variant="outline" ml="2" onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}>
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

function Run({ r, now }: { r: RunSummary; now: number }) {
  const when = <Text as="span" color="fg.muted" textStyle="xs" title={new Date(r.savedAt).toISOString()}>{age(now - r.savedAt)} ago</Text>;
  if (r.unreadable) {
    return (
      <Card.Root borderLeftWidth="4px" borderLeftColor="orange.solid">
        <Card.Body py="3">
          <Badge colorPalette="orange" mr="2">unreadable</Badge>
          <Code>{r.file}</Code> {when}
          <Text color="fg.muted" textStyle="sm">{r.error}</Text>
        </Card.Body>
      </Card.Root>
    );
  }
  return (
    <Card.Root borderLeftWidth="4px" borderLeftColor={`${TONE[r.verdict]}.solid`}>
      <Card.Body py="3">
        <Flex gap="2" align="center" wrap="wrap">
          <Badge colorPalette={TONE[r.verdict]}>{r.verdict}</Badge>
          <Text fontWeight="medium">{r.kind === "eval" ? `Eval, candidate ${r.candidate}` : r.kind === "bench-tiers" ? `Tier benchmark, ${r.role}: ${r.candidate} vs ${r.current}` : `Replay, ${r.repos.join(", ")}`}</Text>
          {when}
        </Flex>
        {r.kind === "eval" ? (
          <>
            <Text textStyle="sm" mt="1">
              {r.split} set: {r.scored} cases scored, {r.newFalseApprovals} new false approvals, {r.newFalseVetoes} new false vetoes
            </Text>
            <Text color="fg.muted" textStyle="sm">
              Vault {r.milestone.current} cases{r.milestone.next === null ? " (all milestones reached)" : `, ${r.milestone.next - r.milestone.current} to the next milestone (${r.milestone.next})`}. Files: {r.files.join(", ") || "none"}
            </Text>
            {r.reasons.length > 0 ? <Text textStyle="sm">{r.reasons.join("; ")}</Text> : null}
          </>
        ) : r.kind === "bench-tiers" ? (
          <Text textStyle="sm" mt="1">{r.verdictLine}</Text>
        ) : (
          <Text textStyle="sm" mt="1">
            {r.replayed} cases replayed, {r.regressions} regressions, {r.mutants} seeded corruptions
          </Text>
        )}
      </Card.Body>
    </Card.Root>
  );
}

export function EvalsPage({ evals, now, onRetry }: { evals: Feed<EvalsState>; now: number; onRetry: () => void }) {
  return (
    <Box maxW="64rem" mx="auto" p="6">
      <Heading size="xl">Evals and replays</Heading>
      <Text color="fg.muted" textStyle="sm">Read-only list of the last reports the CLI saved. Running an eval stays on the command line.</Text>
      {evals.data === null ? (
        evals.error ? (
          <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" p="3" mt="4">
            <Text fontWeight="medium">Reports unavailable.</Text>
            <Text textStyle="sm">{evals.error}</Text>
            <Button size="sm" mt="2" onClick={onRetry}>Retry</Button>
          </Box>
        ) : (
          <Text color="fg.muted" mt="4">Loading reports...</Text>
        )
      ) : (
        <>
          {evals.error ? (
            <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" px="3" py="2" mt="4" textStyle="sm">
              Refresh failed ({evals.error}); showing the last loaded copy.
            </Box>
          ) : null}
          {evals.data.runs.length === 0 ? (
            <Box borderWidth="1px" borderStyle="dashed" rounded="xl" p="5" mt="4" color="fg.muted">
              No eval runs yet. <Code>{EVAL_CMD}</Code>
              <Copy text={EVAL_CMD} />
            </Box>
          ) : (
            <Stack gap="3" mt="4" as="ul" listStyleType="none" aria-label="Runs, newest first">
              {evals.data.runs.map((r) => (
                <li key={r.file}>
                  <Run r={r} now={now} />
                </li>
              ))}
            </Stack>
          )}
        </>
      )}
    </Box>
  );
}
