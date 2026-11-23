import { Box, Button, Flex, Text, chakra } from "@chakra-ui/react";
import { useState } from "react";
import { CAPTION_LABEL } from "../../src/core/recap-chapters.js";
import type { ThreadDetail, TimelineEvent } from "../../src/core/ui-thread.js";
import { Notice, type Feed } from "./AppView";
import { age } from "./common";
import { Check as CheckIcon, Dot as DotIcon, Eye, GitMerge, Hammer, X } from "lucide-react";
import { CopyButton } from "./arc/copy-button/copy-button";
import { Timeline } from "./arc/timeline/timeline";
import { Dot, LinkButton, Ref } from "./page";
import type { ItemRef } from "./route";

// One Thread in the right pane: phase rail, timeline from the Ledger audit (newest first), Gate proof as a checklist.
// Every string here comes from the Ledger and is untrusted: it is only rendered as React text children.

const RAIL: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: "queued", label: "Queued" },
  { kind: "awaiting_plan", label: "Plan" },
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
    <Text textStyle="meta" color={over ? "owner" : "fg.subtle"} whiteSpace="nowrap">
      {text}
    </Text>
  );
}

function PhaseRail({ phase, durations }: { phase: string; durations: PhaseDuration[] }) {
  const at = RAIL.findIndex((r) => r.kind === phase);
  return (
    <Flex align="flex-start" gap="3" wrap="wrap" aria-label="Phase">
      {RAIL.map((r, i) => {
        const d = durations.find((x) => x.kind === r.kind);
        return (
          <Flex key={r.kind} align="flex-start" gap="3" flex={i < RAIL.length - 1 ? "1" : undefined} minW="0">
            <Box>
              <Flex align="center" gap="1.5" textStyle="body13" color={i === at ? "fg" : i < at ? "fg.muted" : "fg.subtle"} fontWeight={i === at ? "500" : undefined} py="1" whiteSpace="nowrap">
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

/** One event's recorded fields, shown when its row is opened. */
function EventDetail({ e }: { e: TimelineEvent }) {
  return (
    <Flex wrap="wrap" columnGap="6" rowGap="2">
      {e.details.map((d, i) => (
        <Box key={`${d.label}-${i}`} minW="0" maxW="100%">
          <Text textStyle="meta" color="fg.subtle">
            {d.label}
          </Text>
          <Flex align="center" gap="2">
            <Text textStyle="meta" color="fg" fontFamily={d.label === "provider" ? undefined : "mono"} wordBreak="break-word">
              {d.value}
            </Text>
            {d.label === "transcript" ? <CopyButton value={d.value} label="Copy path" variant="plain" /> : null}
          </Flex>
        </Box>
      ))}
    </Flex>
  );
}

const Details = chakra("details");
const ICON = { size: 14, "aria-hidden": true } as const;
const eventIcon = (e: TimelineEvent) =>
  e.tone === "failed" ? <X {...ICON} /> : e.kind === "attempt" ? <Hammer {...ICON} /> : e.kind === "review" ? <Eye {...ICON} /> : e.kind === "merge" ? <GitMerge {...ICON} /> : e.tone === "ok" ? <CheckIcon {...ICON} /> : <DotIcon {...ICON} />;
const TONE = { ok: "success", failed: "danger", info: "neutral" } as const;
const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

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
          <Text as="h2" textStyle="title" color="fg" mt="1">
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
      {d.threadRecommendation ? (
        <Box bg="bg.muted" rounded="14px" px="4" py="3">
          <Text textStyle="meta" color="fg.muted">
            The factory recommends, for this Thread
          </Text>
          <Text textStyle="rowTitle" color="fg">
            {d.threadRecommendation.headline}
          </Text>
          <Text textStyle="body13" color="fg.muted">
            {d.threadRecommendation.reason}
          </Text>
        </Box>
      ) : null}
      {d.chapters && d.chapters.length > 0 ? (
        <Box>
          <Flex gap="2" align="baseline" pb="2">
            <Text textStyle="label" fontSize="15px" color="fg">
              Chapters
            </Text>
            <Text textStyle="meta" color="fg.muted">
              the diff grouped by area, read-only
            </Text>
          </Flex>
          <Box borderTopWidth="1px" borderTopColor="fg" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
            {d.chapters.map((c) => (
              <Box key={`${c.kind}-${c.area}`} py="3">
                <Flex gap="3" align="baseline" wrap="wrap">
                  <Text textStyle="rowTitle" color="fg">
                    {c.area === "(root)" ? "Repo root" : `${c.area}/`}
                  </Text>
                  <Text textStyle="meta" color={c.kind === "protected" ? "owner" : "fg.muted"}>
                    {c.kind}
                  </Text>
                  <Text textStyle="meta" color="fg.muted">
                    {c.files.length} file{c.files.length === 1 ? "" : "s"}, +{c.added} -{c.deleted}
                  </Text>
                </Flex>
                <Text textStyle="body13" color="fg.muted">
                  {c.purpose}
                </Text>
                {c.caption ? (
                  <Box mt="1">
                    <Text textStyle="meta" color="fg.subtle">
                      {CAPTION_LABEL}
                    </Text>
                    <Text textStyle="body13" color="fg">
                      {c.caption}
                    </Text>
                  </Box>
                ) : null}
                <Details mt="1">
                  <Text as="summary" textStyle="meta" color="fg.muted" cursor="pointer">
                    Files
                  </Text>
                  {c.files.map((f) => (
                    <Text key={f.path} textStyle="meta" fontFamily="mono" color="fg" wordBreak="break-all">
                      {f.path} +{f.added} -{f.deleted}
                    </Text>
                  ))}
                </Details>
              </Box>
            ))}
          </Box>
        </Box>
      ) : null}
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
            <Box borderTopWidth="1px" borderTopColor="fg" pt="3">
              <Timeline
                label="Timeline"
                now={now}
                timeZone={TIME_ZONE}
                defaultExpanded={events[openAt] ? [`${events[openAt].ts}-${openAt}`] : []}
                events={events.map((e, i) => ({ id: `${e.ts}-${i}`, at: e.ts, title: e.title, tone: TONE[e.tone], icon: eventIcon(e), detail: e.details.length > 0 ? <EventDetail e={e} /> : undefined }))}
              />
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
