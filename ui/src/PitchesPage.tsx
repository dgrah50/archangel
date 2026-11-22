import { Box, Button, Checkbox, Flex, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import type { PitchAttachment, PitchRow, PitchScoutInfo, PitchesState } from "../../src/core/ui-pitches.js";
import { Notice, type Feed } from "./AppView";
import { CopyCommand, LinkButton, Page, PageHeadline, Ref, Section } from "./page";

// Pitch text is model-written and untrusted: it is only ever rendered as React text children. The page never promotes or declines:
// promoting is a command to copy, declining is a link to the issue on GitHub.

const DAY = 86_400_000;
const TYPE = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const RECOMMENDS = { do: "do it", later: "do it later", dont: "do not do it" } as const;
const keyOf = (p: { repo: string; issueNumber: number }) => `${p.repo}#${p.issueNumber}`;
const daysLeft = (p: PitchRow, now: number) => Math.max(0, Math.ceil((p.expiresAt - now) / DAY));
const expires = (p: PitchRow, now: number) => (daysLeft(p, now) === 0 ? "expires today" : `expires in ${daysLeft(p, now)} d`);
const ago = (ms: number) => (ms < DAY ? "today" : `${Math.floor(ms / DAY)} d ago`);

const WHEN = new Intl.DateTimeFormat("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** One plain sentence per repo's pitch Scout, from the server's schedule data. Never a guessed time: a Scout with no clock says so. */
function scoutLine(i: PitchScoutInfo, many: boolean, now: number, pauseAfter: number): string {
  const who = many ? `On ${i.repo}, the` : "The";
  const s = i.scout;
  if (s === null) return `${many ? i.repo : "This repo"} has no pitch Scout.`;
  if (s.hostDisabled) return `${who} pitch Scout is off: Scouts are disabled on this host.`;
  if (s.paused) return `${who} pitch Scout is paused after ${pauseAfter} in a row went unpromoted.`;
  const streak = s.unpromotedInARow === 0 ? "" : ` ${s.unpromotedInARow} in a row ${s.unpromotedInARow === 1 ? "has" : "have"} gone unpromoted so far.`;
  if (s.schedule === "manual") return `${who} pitch Scout runs only when you start it.${streak}`;
  if (s.schedule === "daily") return `${who} pitch Scout runs daily, when the daemon has nothing else to do.${streak}`;
  const next = s.nextRunAt === null || s.nextRunAt <= now ? "due on the next daemon pass" : `next on ${WHEN.format(s.nextRunAt).replace(/^(\w+),? /, "$1 ")}`;
  return `${who} pitch Scout runs weekly, ${next}.${streak}`;
}

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
      <PageHeadline title="Pitches">{n === 0 ? "none open" : `${n} ${n === 1 ? "needs" : "need"} a yes or a no`}</PageHeadline>
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
                  aria-pressed={current !== null && keyOf(current) === keyOf(p)}
                  css={{ "&[aria-pressed=false] h3": { color: "var(--chakra-colors-fg-muted)" } }}
                >
                  <Flex justify="space-between" gap="2">
                    <Text textStyle="meta" color="fg">
                      {TYPE(p.pitch.type)} <Text as="span" color="fg.subtle">· Size {p.pitch.size}</Text>
                    </Text>
                    <Text textStyle="meta" color="fg.subtle">
                      {expires(p, now)}
                    </Text>
                  </Flex>
                  <Text as="h3" textStyle="rowTitle" color="fg" mt="1">
                    {p.pitch.title}
                  </Text>
                  <Flex mt="1" gap="2" color="fg.muted" align="baseline">
                    <Ref repo={p.repo} num={p.issueNumber} />
                    {p.attachments.length > 0 ? <Text textStyle="meta" color="fg.subtle">has pictures</Text> : null}
                  </Flex>
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
            {d.pitchScouts.map((i) => scoutLine(i, d.pitchScouts.length > 1, now, d.pauseAfterUnpromoted)).join(" ")}{" "}
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
          <Text as="span" color="fg">{TYPE(p.type)}</Text> · Size {p.size}, {p.slices.length} {p.slices.length === 1 ? "slice" : "slices"} · <Ref repo={row.repo} num={row.issueNumber} /> · pitched {ago(now - row.filedAt)} by Scout {row.scoutName}
        </Text>
        <Text color="fg">The Scout recommends: {RECOMMENDS[p.recommendation]}</Text>
      </Flex>
      <Text as="h2" textStyle="title" color="fg">
        {p.title}
      </Text>
      {row.attachments.length > 0 ? <Pictures items={row.attachments} /> : null}
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

const assetUrl = (a: PitchAttachment) => `/api/pitch-asset/${a.sha256}`;

/** Host-validated images from the repo. Only the stored image is shown, by its hash; captions and paths are React text. */
function Pictures({ items }: { items: PitchAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const paths = [...new Set(items.map((a) => a.path))];
  return (
    <Section gap="3">
      <Flex gap="10" direction={{ base: "column", xl: "row" }} justify="space-between">
        <Box minW="0" maxW="320px">
          <Text textStyle="body13" color="fg.subtle">Pictures, {items.length}</Text>
          <Text textStyle="meta" color="fg.muted" mt="1">From the repo</Text>
          {paths.map((path) => (
            <Text key={path} textStyle="ref" color="fg.muted" wordBreak="break-all">{path}</Text>
          ))}
        </Box>
        <Flex gap="4" wrap="wrap" align="flex-start">
          {items.map((a, i) => (
            <Box key={a.sha256} w="160px">
              <Box as="button" cursor="zoom-in" display="block" w="160px" borderWidth="1px" borderColor="border" onClick={() => setOpen(i)} aria-label={`Open picture: ${a.caption}`}>
                <img src={assetUrl(a)} alt="" width="160" style={{ display: "block", width: "160px", height: "auto" }} />
              </Box>
              <Text textStyle="meta" color="fg.subtle" mt="1">{a.caption}</Text>
            </Box>
          ))}
        </Flex>
      </Flex>
      {open !== null ? <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} /> : null}
    </Section>
  );
}

function Lightbox({ items, index, onIndex, onClose }: { items: PitchAttachment[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onIndex((index + 1) % items.length);
      else if (e.key === "ArrowLeft") onIndex((index - 1 + items.length) % items.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, items.length, onIndex, onClose]);
  const a = items[index]!;
  return (
    <Flex role="dialog" aria-modal="true" aria-label="Picture" position="fixed" inset="0" zIndex="overlay" bg="blackAlpha.800" direction="column" align="center" justify="center" gap="3" p="6" onClick={onClose}>
      <img src={assetUrl(a)} alt="" style={{ maxWidth: "90vw", maxHeight: "80vh", objectFit: "contain" }} onClick={(e) => e.stopPropagation()} />
      <Text textStyle="body13" color="white" onClick={(e) => e.stopPropagation()}>
        {a.caption} <Text as="span" color="whiteAlpha.700">({index + 1} of {items.length})</Text>
      </Text>
    </Flex>
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
