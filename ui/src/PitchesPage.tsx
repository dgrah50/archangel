import { Box, Button, Checkbox, Flex, Text } from "@chakra-ui/react";
import { useState } from "react";
import type { PitchRow, PitchesState } from "../../src/core/ui-pitches.js";
import { Notice, type Feed } from "./AppView";
import { CopyCommand, LinkButton, Owed, Page, PageHeadline, Ref, Section } from "./page";

// Pitch text is model-written and untrusted: it is only ever rendered as React text children. The page never promotes or declines:
// promoting is a command to copy, declining is a link to the issue on GitHub.

const DAY = 86_400_000;
const TYPE = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const RECOMMENDS = { do: "do it", later: "do it later", dont: "do not do it" } as const;
const keyOf = (p: { repo: string; issueNumber: number }) => `${p.repo}#${p.issueNumber}`;
const daysLeft = (p: PitchRow, now: number) => Math.max(0, Math.ceil((p.expiresAt - now) / DAY));
const expires = (p: PitchRow, now: number) => (daysLeft(p, now) === 0 ? "expires today" : `expires in ${daysLeft(p, now)} d`);
const ago = (ms: number) => (ms < DAY ? "today" : `${Math.floor(ms / DAY)} d ago`);

const outcome = (s: PitchesState["decided"][number]["state"]) =>
  s.kind === "promoted" ? "Promoted" : s.kind === "partially_promoted" ? `Promoted ${s.promotedSlices.length}` : s.kind === "declined" ? "Declined" : s.kind === "expired" ? "Expired" : "Open";

export function PitchesPage({ pitches, now, onRetry }: { pitches: Feed<PitchesState>; now: number; onRetry: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  if (pitches.data === null) {
    if (pitches.error === null) return <Text p="6" color="fg.muted">Loading...</Text>;
    return (
      <Page>
        <Notice tone="red">
          <Text textStyle="sm">{pitches.error}</Text>
          <Button size="sm" mt="2" onClick={onRetry}>
            Retry
          </Button>
        </Notice>
      </Page>
    );
  }
  const d = pitches.data;
  const n = d.open.length;
  const current = d.open.find((p) => keyOf(p) === picked) ?? d.open[0] ?? null;
  return (
    <Page>
      <PageHeadline sub="Ideas a Scout thinks are worth building. Nothing starts until you promote a slice.">
        {n === 0 ? "No pitches need a yes or a no." : (
          <>
            <Owed>{n} {n === 1 ? "pitch" : "pitches"}</Owed> {n === 1 ? "needs" : "need"} a yes or a no.
          </>
        )}
      </PageHeadline>
      <Flex direction={{ base: "column", lg: "row" }} gap="10" flex="1" align="stretch">
        <Flex direction="column" w={{ lg: "300px" }} flexShrink={0} gap="6">
          {n > 0 ? (
            <Section>
              {d.open.map((p) => (
                <Box
                  as="button"
                  key={keyOf(p)}
                  textAlign="start"
                  cursor="pointer"
                  onClick={() => setPicked(keyOf(p))}
                  pb="3"
                  borderBottomWidth="1px"
                  borderBottomColor="border"
                  opacity={current && keyOf(current) === keyOf(p) ? 1 : 0.62}
                >
                  <Flex justify="space-between" gap="2">
                    <Text textStyle="meta" color="owner">
                      {TYPE(p.pitch.type)} <Text as="span" color="fg.subtle">· Size {p.pitch.size}</Text>
                    </Text>
                    <Text textStyle="meta" color="fg.subtle">
                      {expires(p, now)}
                    </Text>
                  </Flex>
                  <Text textStyle="rowTitle" color="fg" mt="1">
                    {p.pitch.title}
                  </Text>
                  <Box mt="1" color="fg.muted">
                    <Ref repo={p.repo} num={p.issueNumber} />
                  </Box>
                </Box>
              ))}
            </Section>
          ) : null}
          {d.decided.length > 0 ? (
            <Section title="Decided recently">
              {d.decided.map((p) => (
                <Flex key={keyOf(p)} justify="space-between" gap="3" textStyle="body13" color="fg.muted">
                  <Text truncate>{p.title}</Text>
                  <Text flexShrink={0} color="fg">
                    {outcome(p.state)}
                  </Text>
                </Flex>
              ))}
            </Section>
          ) : null}
          <Box flex="1" />
          <Text textStyle="meta" color="fg.subtle">
            At most {d.maxOpen} pitches stay open. The pitch Scout pauses after {d.pauseAfterUnpromoted} in a row go unpromoted.
          </Text>
        </Flex>
        {current ? <Detail row={current} d={d} now={now} /> : null}
      </Flex>
    </Page>
  );
}

function Detail({ row, d, now }: { row: PitchRow; d: PitchesState; now: number }) {
  const p = row.pitch;
  const done = row.state.kind === "partially_promoted" ? row.state.promotedSlices : [];
  const [ticked, setTicked] = useState<{ key: string; slices: number[] }>({ key: "", slices: [] });
  const chosen = ticked.key === keyOf(row) ? ticked.slices : [];
  const toggle = (i: number) => setTicked({ key: keyOf(row), slices: chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i].sort((a, b) => a - b) });
  const left = daysLeft(row, now);
  return (
    <Section flex="1" minW="0" gap="5" key={keyOf(row)}>
      <Flex justify="space-between" gap="4" wrap="wrap" textStyle="meta" color="fg.subtle">
        <Text>
          <Text as="span" color="owner">{TYPE(p.type)}</Text> · Size {p.size}, {p.slices.length} {p.slices.length === 1 ? "slice" : "slices"} · <Ref repo={row.repo} num={row.issueNumber} /> · pitched {ago(now - row.filedAt)} by Scout {row.scoutName}
        </Text>
        <Text color="fg">The Scout recommends: {RECOMMENDS[p.recommendation]}</Text>
      </Flex>
      <Text as="h2" textStyle="headline" fontSize="30px" lineHeight="36px" color="fg">
        {p.title}
      </Text>
      <Flex gap="10" direction={{ base: "column", xl: "row" }}>
        <Flex direction="column" gap="4" flex="1" minW="0">
          <Field label="The problem">{p.problem}</Field>
          <Field label="The proposal">{p.proposal}</Field>
          <Field label="Smallest version worth shipping">{p.smallestVersion}</Field>
          {p.measurement.trim() ? <Field label="How it will be measured">{p.measurement}</Field> : null}
        </Flex>
        <Flex direction="column" gap="4" flex="1" minW="0">
          <Box>
            <Text textStyle="body13" color="fg.subtle">Evidence, {p.evidence.length} items</Text>
            {p.evidence.map((e, i) => (
              <Flex key={i} gap="4" mt="2" textStyle="body13">
                <Text textStyle="ref" w="120px" flexShrink={0} color="fg.muted" wordBreak="break-all">
                  {[e.file, e.symbol, e.metric].filter(Boolean).join(" ") || "note"}
                </Text>
                <Text flex="1">{e.note}</Text>
              </Flex>
            ))}
          </Box>
          <Box>
            <Text textStyle="body13" color="fg.subtle">Options it considered</Text>
            {p.optionsConsidered.map((o, i) => (
              <Text key={i} textStyle="body13" mt="2">
                {o}
              </Text>
            ))}
          </Box>
        </Flex>
      </Flex>
      <Flex align="baseline" gap="3" wrap="wrap">
        <Text textStyle="label" fontSize="15px" color="fg">Choose what to start</Text>
        <Text textStyle="meta" color="fg.subtle">Each slice you promote becomes one Thread. Features always land by your merge.</Text>
      </Flex>
      <Flex direction="column" borderTopWidth="1px" borderTopColor="border" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }} borderBottomWidth="1px" borderBottomColor="border">
        {p.slices.map((s, i) => {
          const promoted = done.includes(i);
          return (
            <Checkbox.Root key={i} py="3.5" alignItems="flex-start" disabled={promoted} checked={promoted || chosen.includes(i)} onCheckedChange={() => toggle(i)}>
              <Checkbox.HiddenInput />
              <Checkbox.Control mt="1px" />
              <Checkbox.Label>
                <Text textStyle="label" color="fg">
                  {i + 1} · {s.title}
                  {promoted ? <Text as="span" color="fg.subtle"> (already promoted)</Text> : null}
                </Text>
                <Text textStyle="meta" color="fg.muted">Done when: {s.acceptance}</Text>
              </Checkbox.Label>
            </Checkbox.Root>
          );
        })}
      </Flex>
      <Flex gap="6" align="flex-start" direction={{ base: "column", xl: "row" }}>
        <Flex direction="column" gap="2" flex="1" minW="0">
          {chosen.length > 0 ? (
            <>
              <Text textStyle="label" color="fg">Promote {chosen.length} {chosen.length === 1 ? "slice" : "slices"} on GitHub</Text>
              <CopyCommand command={`archangel pitch promote ${row.repo} ${row.issueNumber} --slice ${chosen.map((i) => i + 1).join(",")}`} />
            </>
          ) : (
            <Text textStyle="meta" color="fg.subtle">Tick the slices to start, and the command to promote them appears here.</Text>
          )}
        </Flex>
        <Flex direction="column" gap="2" flex="1" minW="0" align="flex-start">
          <LinkButton href={`https://github.com/${row.repo}/issues/${row.issueNumber}`} external>
            Decline with a reason
          </LinkButton>
          <Text textStyle="meta" color="fg.subtle">
            Closing the issue with a comment declines the pitch, and your comment becomes the reason the next Scout sees. Left alone it expires {left === 0 ? "today" : `in ${left} days`}; a declined idea is not pitched again for {d.declineWindowDays} days. Either answer counts as hearing from you.
          </Text>
        </Flex>
      </Flex>
    </Section>
  );
}

function Field({ label, children }: { label: string; children: string }) {
  return (
    <Box>
      <Text textStyle="body13" color="fg.subtle">{label}</Text>
      <Text textStyle="body13" color="fg" mt="1">{children}</Text>
    </Box>
  );
}
