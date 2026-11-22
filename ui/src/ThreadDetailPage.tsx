import { Box, Button, Flex, Text, chakra } from "@chakra-ui/react";
import { useState } from "react";
import type { ThreadDetail, TimelineEvent } from "../../src/core/ui-thread.js";
import { Notice, type Feed } from "./AppView";
import { age } from "./common";
import { Dot, LinkButton, Ref } from "./page";
import type { ItemRef } from "./route";

// One Thread in the right pane: phase rail, timeline from the Ledger audit (newest first), Gate proof as a checklist.
// Every string here comes from the Ledger and is untrusted: it is only rendered as React text children.

const RAIL: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: "queued", label: "Queued" },
  { kind: "working", label: "Working" },
  { kind: "awaiting_gate", label: "Waiting on Gate" },
  { kind: "reviewing", label: "Review" },
  { kind: "landing", label: "Landing" },
];

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m2.5 6.5 2.3 2.3 4.7-5.3" />
    </svg>
  );
}

type PhaseDuration = ThreadDetail["phaseDurations"][number];

const mins = (ms: number) => (ms < 60_000 ? "<1 m" : ms < 120 * 60_000 ? `${Math.floor(ms / 60_000)} m` : `${Math.floor(ms / 3_600_000)} h`);

function Duration({ d }: { d: PhaseDuration }) {
  const over = d.running && d.limitMs !== null && d.ms > d.limitMs;
  const text = d.running ? (d.limitMs !== null ? `${mins(d.ms)} of ${Math.round(d.limitMs / 60_000)}` : `running ${mins(d.ms)}`) : mins(d.ms);
  return (
    <Text textStyle="meta" color={over ? "owner" : "fg.subtle"} whiteSpace="nowrap" px="2.5">
      {text}
    </Text>
  );
}

function PhaseRail({ phase, durations }: { phase: string; durations: PhaseDuration[] }) {
  const at = RAIL.findIndex((r) => r.kind === phase);
  return (
    <Flex align="flex-start" gap="3" wrap="wrap" bg="bg.subtle" rounded="14px" px="4" py="2.5" aria-label="Phase">
      {RAIL.map((r, i) => {
        const d = durations.find((x) => x.kind === r.kind);
        return (
          <Flex key={r.kind} align="flex-start" gap="3" flex={i < RAIL.length - 1 ? "1" : undefined} minW="0">
            <Box>
              <Flex align="center" gap="1.5" textStyle="body13" color={i === at ? "fg" : i < at ? "fg.muted" : "fg.subtle"} fontWeight={i === at ? "500" : undefined} borderWidth="1px" borderColor={i === at ? "border" : "transparent"} bg={i === at ? "bg" : undefined} rounded="full" px="2.5" py="1" whiteSpace="nowrap">
                {i < at ? <Check /> : i === at ? <Dot /> : null}
                {r.label}
              </Flex>
              {d ? <Duration d={d} /> : null}
            </Box>
            {i < RAIL.length - 1 ? <Box flex="1" minW="3" mt="14px" borderTopWidth="1px" borderTopStyle={i < at ? "solid" : "dashed"} borderTopColor="border.emphasized" /> : null}
          </Flex>
        );
      })}
      {at === -1 ? (
        <Text textStyle="meta" color="fg.muted" alignSelf="center">
          Now: {phase.replace(/_/g, " ")}
        </Text>
      ) : null}
    </Flex>
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

const Details = chakra("details");

function TimelineRow({ e, now, open }: { e: TimelineEvent; now: number; open: boolean }) {
  return (
    <Flex as="li" gap="4" py="3" role={e.tone === "failed" ? "alert" : undefined}>
      <Text textStyle="ref" color="fg.subtle" w="44px" flexShrink={0} pt="2px" title={new Date(e.ts).toISOString()}>
        {clock(e.ts)}
      </Text>
      <Box pt="5px">{e.tone === "failed" ? <Dot tone="owner" /> : e.kind === "attempt" ? <Dot /> : <Dot tone="hollow" />}</Box>
      <Details open={open} flex="1" minW="0">
        <Text as="summary" textStyle="label" color="fg" cursor="pointer">
          {e.title}{" "}
          <Text as="span" textStyle="meta" color="fg.subtle" fontWeight="400">
            {age(now - e.ts)} ago
          </Text>
        </Text>
        <Flex mt="2" gap="x" wrap="wrap" columnGap="6" rowGap="2" borderWidth={e.kind === "attempt" ? "1px" : undefined} borderColor="border" rounded="12px" p={e.kind === "attempt" ? "3" : undefined}>
          {e.details.map((d, i) => (
            <Box key={`${d.label}-${i}`} minW="0" maxW="100%">
              <Text textStyle="meta" color="fg.subtle">
                {d.label}
              </Text>
              <Text textStyle="meta" color="fg" fontFamily={d.label === "provider" ? undefined : "mono"} wordBreak="break-word">
                {d.value}
                {d.label === "transcript" ? <CopyPath path={d.value} /> : null}
              </Text>
            </Box>
          ))}
        </Flex>
      </Details>
    </Flex>
  );
}

export function ThreadDetailPage({ item, thread, now, onRetry }: { item: ItemRef; thread: Feed<ThreadDetail>; now: number; onRetry: () => void }) {
  if (thread.data === null) {
    return (
      <Box p="6">
        {thread.error === null ? (
          <Text color="fg.muted">Loading thread...</Text>
        ) : (
          <Notice tone="red">
            <Text fontWeight="medium">
              {item.repo}#{item.issue} could not be loaded.
            </Text>
            <Text textStyle="sm">{thread.error}</Text>
            <Button size="sm" mt="2" onClick={onRetry}>
              Retry
            </Button>
          </Notice>
        )}
      </Box>
    );
  }
  const d = thread.data;
  const events = [...d.events].reverse();
  const openAt = events.findIndex((e) => e.kind === "attempt");
  const slug = /^[\w.-]+\/[\w.-]+$/.test(d.repo);
  return (
    <Flex direction="column" gap="5" p="6" minW="0">
      <Flex justify="space-between" align="flex-start" gap="4" wrap="wrap">
        <Box minW="0" flex="1">
          <Text textStyle="meta" color="fg.muted">
            <Ref repo={d.repo} num={d.issueNumber} />
          </Text>
          <Text as="h2" textStyle="headline" fontSize="28px" lineHeight="34px" color="fg" mt="1">
            {d.title}
          </Text>
        </Box>
        {slug ? (
          <Flex gap="2">
            <LinkButton external href={`https://github.com/${d.repo}/issues/${d.issueNumber}`}>
              Issue
            </LinkButton>
            {d.prNumber ? (
              <LinkButton external href={`https://github.com/${d.repo}/pull/${d.prNumber}`}>
                {`PR #${d.prNumber}`}
              </LinkButton>
            ) : null}
          </Flex>
        ) : null}
      </Flex>
      {thread.error ? (
        <Notice tone="red">
          <Text textStyle="sm">Refresh failed ({thread.error}); showing the last loaded copy.</Text>
        </Notice>
      ) : null}
      <PhaseRail phase={d.phase} durations={d.phaseDurations} />
      <Flex direction={{ base: "column", xl: "row" }} gap="8" align="flex-start">
        <Box flex="1" minW="0" w="full">
          <Flex gap="2" align="baseline" pb="2">
            <Text textStyle="label" fontSize="15px" color="fg">
              Timeline
            </Text>
            <Text textStyle="meta" color="fg.muted">
              Ledger audit, newest first{d.auditTruncated ? " (last 500 events)" : ""}
            </Text>
          </Flex>
          {events.length === 0 ? (
            <Text color="fg.muted" borderTopWidth="1px" borderTopColor="fg" pt="3">
              No recorded events yet.
            </Text>
          ) : (
            <Box as="ol" listStyleType="none" borderTopWidth="1px" borderTopColor="fg" aria-label="Timeline" css={{ "& > li + li": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
              {events.map((e, i) => (
                <TimelineRow key={`${e.ts}-${i}`} e={e} now={now} open={i === openAt} />
              ))}
            </Box>
          )}
        </Box>
        <Box w={{ xl: "280px" }} flexShrink={0} alignSelf="stretch">
          <Flex gap="2" align="baseline" pb="2">
            <Text textStyle="label" fontSize="15px" color="fg">
              Gate proof
            </Text>
            <Text textStyle="meta" color="fg.muted">
              mechanical, models only veto
            </Text>
          </Flex>
          <Box borderTopWidth="1px" borderTopColor="fg" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
            {d.gate.length === 0 ? (
              <Text textStyle="body13" color="fg.muted" pt="3">
                No Gate result recorded yet.
              </Text>
            ) : (
              d.gate.map((g, i) => (
                <Flex key={i} align="baseline" gap="2.5" py="2.5" textStyle="body13" color="fg">
                  <Box color={g.passed ? "passed" : "fg.muted"} flexShrink={0}>
                    {g.passed ? <Check /> : "x"}
                  </Box>
                  <Text flex="1" minW="0" wordBreak="break-word">
                    {g.label}
                  </Text>
                  <Text textStyle="meta" color={g.passed ? "passed" : "fg.muted"} flexShrink={0}>
                    {g.passed ? "passed" : "failed"}
                  </Text>
                </Flex>
              ))
            )}
          </Box>
        </Box>
      </Flex>
    </Flex>
  );
}
