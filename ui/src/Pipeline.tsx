import { Badge, Box, Card, Heading, SimpleGrid, Stack, Text } from "@chakra-ui/react";
import type { PipelineItem, PipelineRepo, WorkflowsState } from "../../src/core/ui-state.js";

// Everything here is rendered as React text children. Values originate in a repo's workflow file (untrusted) and are never HTML.

const CHIP_COLOR: Record<PipelineItem["source"], string> = { kernel: "purple", host: "orange", repo: "blue" };

function Chip({ source }: { source: PipelineItem["source"] }) {
  return (
    <Badge colorPalette={CHIP_COLOR[source]} ml="2">
      {source}
    </Badge>
  );
}

function Halted({ r }: { r: PipelineRepo }) {
  if (r.status === "ok") return null;
  const text =
    r.status === "missing"
      ? "Workflow file missing: this repo is halted (no intake, Scouts or autonomous landing) until .agents/archangel.json is on main."
      : r.status === "invalid"
        ? "Workflow file invalid: this repo is halted until it is fixed. Nothing falls back to another policy."
        : "Not resolved yet: the daemon has not read this repo's workflow.";
  return (
    <Box borderWidth="1px" borderColor="red.solid" rounded="md" p="3" mb="3" role="alert">
      <Badge colorPalette="red" mr="2">
        {r.status}
      </Badge>
      {text}
      {r.error ? (
        <Text color="fg.muted" textStyle="sm" mt="1">
          {r.error}
        </Text>
      ) : null}
    </Box>
  );
}

export function Pipeline({ data }: { data: WorkflowsState }) {
  return (
    <Box as="section" mt="10">
      <Heading size="lg" mb="1">
        Pipeline
      </Heading>
      <Text color="fg.muted" textStyle="sm" mb="4">
        Resolved workflow per repo: kernel invariants, host ceilings, repo choices. Metrics cover the last {data.windowDays} days.
      </Text>
      {data.repos.length === 0 ? <Text color="fg.muted">No repos yet.</Text> : null}
      <Stack gap="8">
        {data.repos.map((r) => (
          <Box key={r.repo}>
            <Heading size="md" mb="2">
              {r.repo}
              {r.fileSha256 ? (
                <Text as="span" color="fg.muted" textStyle="sm" ml="2">
                  file {r.fileSha256.slice(0, 8)}
                </Text>
              ) : null}
            </Heading>
            <Halted r={r} />
            <SimpleGrid columns={{ base: 1, md: 2 }} gap="3">
              {r.stages.map((st) => (
                <Card.Root key={st.id}>
                  <Card.Body>
                    <Text fontWeight="medium">{st.title}</Text>
                    {st.items.map((i) => (
                      <Text key={`${i.label}:${i.source}`} textStyle="sm">
                        {i.label}: {i.value}
                        <Chip source={i.source} />
                      </Text>
                    ))}
                    {st.clamps.map((c) => (
                      <Text key={c} textStyle="sm" color="orange.fg">
                        Clamped: {c}
                      </Text>
                    ))}
                    {st.metrics.map((m) => (
                      <Text key={m} textStyle="xs" color="fg.muted">
                        {m}
                      </Text>
                    ))}
                  </Card.Body>
                </Card.Root>
              ))}
            </SimpleGrid>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}
