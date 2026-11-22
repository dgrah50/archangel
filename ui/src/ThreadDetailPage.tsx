import { Badge, Box, Button, Code, Flex, Heading, Link, Stack, Text } from "@chakra-ui/react";
import { useState } from "react";
import type { LogsPayload, ThreadDetail, TimelineEvent } from "../../src/core/ui-thread.js";
import type { Feed } from "./AppView";
import { GhLink, STATUS_PALETTE, age } from "./common";
import type { ItemRef } from "./route";

const TONE: Record<TimelineEvent["tone"], string> = { ok: "green", failed: "red", info: "gray" };
const LEVEL: Record<string, string> = { error: "red", warn: "orange", info: "gray" };

function Row({ e, now }: { e: TimelineEvent; now: number }) {
  return (
    <Box as="li" borderLeftWidth="3px" borderLeftColor={e.tone === "failed" ? "red.solid" : e.tone === "ok" ? "green.solid" : "border"} pl="3" py="1" role={e.tone === "failed" ? "alert" : undefined}>
      <Box as="details">
        <Box as="summary" cursor="pointer">
          <Badge colorPalette={TONE[e.tone]} mr="2">
            {e.kind}
          </Badge>
          {e.title}{" "}
          <Text as="span" color="fg.muted" textStyle="xs" title={new Date(e.ts).toISOString()}>
            {age(now - e.ts)} ago
          </Text>
        </Box>
        <Stack gap="0" mt="1" textStyle="sm">
          {e.details.map((d, i) => (
            <Text key={`${d.label}-${i}`} color="fg.muted">
              {d.label}: <Code>{d.value}</Code>
              {d.label === "transcript" ? <CopyPath path={d.value} /> : null}
            </Text>
          ))}
        </Stack>
      </Box>
    </Box>
  );
}

function CopyPath({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="2xs" variant="ghost" ml="2" onClick={() => void navigator.clipboard.writeText(path).then(() => setDone(true))}>
      {done ? "Copied" : "Copy path"}
    </Button>
  );
}

export function ThreadDetailPage({ item, thread, logs, now, onRetry }: { item: ItemRef; thread: Feed<ThreadDetail>; logs: Feed<LogsPayload>; now: number; onRetry: () => void }) {
  const back = (
    <Link href="#/threads" textStyle="sm">
      Threads
    </Link>
  );
  if (thread.data === null) {
    return (
      <Box maxW="64rem" mx="auto" p="6">
        {back}
        {thread.error === null ? (
          <Text color="fg.muted" mt="3">Loading thread...</Text>
        ) : (
          <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" p="3" mt="3">
            <Text fontWeight="medium">{item.repo}#{item.issue} could not be loaded.</Text>
            <Text textStyle="sm">{thread.error}</Text>
            <Button size="sm" mt="2" onClick={onRetry}>Retry</Button>
          </Box>
        )}
      </Box>
    );
  }
  const d = thread.data;
  return (
    <Box maxW="64rem" mx="auto" p="6">
      {back} / <Text as="span" textStyle="sm">{d.repo}#{d.issueNumber}</Text>
      <Heading size="xl" mt="2">{d.title}</Heading>
      <Flex gap="3" mt="2" align="center" wrap="wrap" textStyle="sm">
        <Badge colorPalette={STATUS_PALETTE[d.phase] ?? "gray"}>{d.phase.replace(/_/g, " ")}</Badge>
        <GhLink repo={d.repo} kind="issues" num={d.issueNumber}>issue on GitHub</GhLink>
        {d.prNumber ? <GhLink repo={d.repo} kind="pull" num={d.prNumber}>{`PR #${d.prNumber}`}</GhLink> : null}
      </Flex>
      {thread.error ? (
        <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" px="3" py="2" mt="3" textStyle="sm">
          Refresh failed ({thread.error}); showing the last loaded copy.
        </Box>
      ) : null}
      <Heading size="md" mt="6" mb="2">Timeline</Heading>
      {d.auditTruncated ? <Text color="fg.muted" textStyle="sm">Showing last 500 audit events.</Text> : null}
      {d.events.length === 0 ? (
        <Text color="fg.muted">No recorded events yet.</Text>
      ) : (
        <Stack as="ol" listStyleType="none" gap="2" aria-label="Timeline">
          {d.events.map((e, i) => (
            <Row key={`${e.ts}-${i}`} e={e} now={now} />
          ))}
        </Stack>
      )}
      <Heading size="md" mt="6" mb="2">Log</Heading>
      <Logs logs={logs} />
    </Box>
  );
}

function Logs({ logs }: { logs: Feed<LogsPayload> }) {
  if (logs.data === null) return <Text color="fg.muted">{logs.error ? `Log unavailable: ${logs.error}` : "Loading log..."}</Text>;
  if (logs.data.missing) return <Text color="fg.muted">No log file is configured or it does not exist yet.</Text>;
  if (logs.data.entries.length === 0) return <Text color="fg.muted">No log entries for this Thread.</Text>;
  return (
    <Stack gap="0" fontFamily="mono" textStyle="xs" aria-label="Log">
      {logs.data.entries.map((l, i) => (
        <Text key={`${l.ts}-${i}`}>
          <Badge colorPalette={LEVEL[l.level] ?? "gray"} mr="2">{l.level}</Badge>
          {l.ts.slice(11, 19)} {l.event} {l.message}
        </Text>
      ))}
    </Stack>
  );
}
