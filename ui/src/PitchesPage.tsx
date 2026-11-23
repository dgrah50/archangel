import { Box, Button, Checkbox, Flex, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import { isMeasured } from "../../src/core/pitch.js";
import { diagramRows } from "../../src/core/pitch-diagram.js";
import type { PitchAttachment, PitchRow, PitchScoutInfo, PitchesState } from "../../src/core/ui-pitches.js";
import { Notice, type Feed } from "./AppView";
import { Badge } from "./arc/badge/badge";
import { Skeleton } from "./arc/skeleton/skeleton";
import { CopyCommand, LinkButton, MasterDetail, Page, PageHeadline, PickRow, Ref, Section } from "./page";

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
    if (pitches.error === null) {
      return (
        <Page>
          <PageHeadline title="Pitches" />
          <Skeleton label="Loading pitches" lines={4} />
        </Page>
      );
    }
    return (
      <Page>
        <Notice tone="red" title="Pitches could not be loaded">
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
    <Page px="0" pb="0">
      <Box px={{ base: "6", md: "56px" }}>
        <PageHeadline title="Pitches">{n === 0 ? "none open" : `${n} ${n === 1 ? "needs" : "need"} a yes or a no`}</PageHeadline>
      </Box>
      <MasterDetail
        list={
          <>
            {n > 0 ? (
              <Flex as="ul" listStyleType="none" direction="column" gap="1" aria-label="Open pitches">
                {d.open.map((p) => (
                  <li key={keyOf(p)}>
                    <PickRow selected={current !== null && keyOf(current) === keyOf(p)} onClick={() => setPicked(keyOf(p))} py="2.5" align="stretch" direction="column" gap="1">
                      <Flex justify="space-between" align="center" gap="2">
                        <Flex gap="1.5">
                          <Badge size="sm">{TYPE(p.pitch.type)}</Badge>
                          <Badge size="sm" outline>Size {p.pitch.size}</Badge>
                        </Flex>
                        <Text textStyle="meta" color="fg.subtle">
                          {expires(p, now)}
                        </Text>
                      </Flex>
                      <Text as="h3" textStyle="label" color="fg">
                        {p.pitch.title}
                      </Text>
                      <Flex gap="2" color="fg.muted" align="baseline">
                        <Ref repo={p.repo} num={p.issueNumber} />
                        {p.attachments.length > 0 ? <Text textStyle="meta" color="fg.subtle">has pictures</Text> : null}
                      </Flex>
                    </PickRow>
                  </li>
                ))}
              </Flex>
            ) : null}
            {d.decided.length > 0 ? (
              <Flex direction="column" gap="2" px="3" pt="5">
                <Text textStyle="meta" color="fg.subtle">Decided recently</Text>
                {d.decided.map((p) => (
                  <Flex key={keyOf(p)} justify="space-between" gap="3" textStyle="body13" color="fg.muted">
                    <Text truncate>{p.title}</Text>
                    <Text flexShrink={0} color="fg">
                      {outcome(p.state)}
                    </Text>
                  </Flex>
                ))}
              </Flex>
            ) : null}
            <Box flex="1" />
            <Text textStyle="meta" color="fg.subtle" px="3" pt="6">
              {d.pitchScouts.map((i) => scoutLine(i, d.pitchScouts.length > 1, now, d.pauseAfterUnpromoted)).join(" ")}{" "}
              At most {d.maxOpen} pitches stay open. The pitch Scout pauses after {d.pauseAfterUnpromoted} in a row go unpromoted.
            </Text>
          </>
        }
      >
        {current ? <Detail row={current} d={d} now={now} /> : null}
      </MasterDetail>
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
      {row.pitch.changeDiagram ? <ChangeDiagramBlock diagram={row.pitch.changeDiagram} /> : null}
      {row.pitch.estimates.length > 0 ? <Estimates items={row.pitch.estimates} /> : null}
      <TryIt row={row} d={d} now={now} />
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
                  {promoted ? <> <Badge size="sm" tone="success" dot>already promoted</Badge></> : null}
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

const CHANGE_WORD = { add: "added", remove: "removed", modify: "changed", same: "unchanged" } as const;
const CHANGE_BADGE = { add: { tone: "success" }, remove: { tone: "neutral", outline: true }, modify: { tone: "neutral" }, same: { tone: "neutral", outline: true } } as const;

/** The model's nodes and edges, drawn here as an indented tree of React text. Nothing from the pitch is ever markup. */
function ChangeDiagramBlock({ diagram }: { diagram: NonNullable<PitchRow["pitch"]["changeDiagram"]> }) {
  return (
    <Section inner gap="2">
      <Text textStyle="body13" color="fg.subtle">What changes</Text>
      <Box borderLeftWidth="1px" borderLeftColor="border" pl="3">
        {diagramRows(diagram).map((r, i) => (
          <Flex key={i} gap="3" align="baseline">
            <Box w="84px" flexShrink={0}>
              <Badge size="sm" {...CHANGE_BADGE[r.change]}>{CHANGE_WORD[r.change]}</Badge>
            </Box>
            <Text textStyle="body13" color={r.change === "same" ? "fg.muted" : "fg"} pl={`${r.depth * 20}px`}>
              {r.label}
              {r.repeat ? <Text as="span" color="fg.subtle"> (shown above)</Text> : null}
            </Text>
          </Flex>
        ))}
      </Box>
    </Section>
  );
}

/** Numbers the pitch claims. Each says "Estimate, not measured" unless it is a measured number that cites a repo file. */
function Estimates({ items }: { items: PitchRow["pitch"]["estimates"] }) {
  return (
    <Section inner gap="2">
      <Text textStyle="body13" color="fg.subtle">Numbers it claims</Text>
      {items.map((e, i) => (
        <Box key={i}>
          <Flex gap="3" align="baseline" wrap="wrap">
            <Text textStyle="body13" color="fg" fontWeight="medium">{e.metric}</Text>
            <Text textStyle="body13" color="fg">{e.before === null ? "" : `${e.before} -> `}{e.after} {e.unit}</Text>
            <Badge size="sm" tone={isMeasured(e) ? "success" : "neutral"}>{isMeasured(e) ? "Measured" : "Estimate, not measured"}</Badge>
          </Flex>
          <Text textStyle="meta" color="fg.muted">Method: {e.method}{isMeasured(e) ? <> Evidence: <Text as="span" textStyle="ref">{e.source}</Text></> : null}</Text>
        </Box>
      ))}
    </Section>
  );
}

const POC_FAILURES: Record<string, string> = {
  over_budget: "the daily budget was used up",
  provider_unavailable: "no agent was available",
  implementer_failed: "the agent did not finish",
  setup_failed: "the repo's setup script failed",
  empty: "the agent changed nothing",
  out_of_bounds: "the change was over the size limits",
  aborted: "it was stopped",
  internal: "something went wrong inside Archangel",
};

const STOPPED: Record<string, string> = {
  ttl: "it reached its 60 minute limit",
  idle: "nobody used it for 15 minutes",
  owner: "you stopped it",
  restart: "the runner went away",
};

/** The proof-of-concept state in plain words. Starting a preview stays a command to copy; the page only shows that one runs and links to it. */
function TryIt({ row, d, now }: { row: PitchRow; d: PitchesState; now: number }) {
  const poc = row.poc;
  const used = poc === null ? 0 : poc.builds;
  const left = d.pocMaxBuildsPerPitch - used;
  const ask = (
    <Flex direction="column" gap="2" align="flex-start">
      <Text textStyle="meta" color="fg.muted">
        {left > 0 ? `Build a throwaway PoC so you can see how big it really is. It stays on this machine and is never pushed. Uses one of your ${d.pocMaxBuildsPerDay} builds a day (${d.pocBuildsToday} used in the last 24 hours).` : `This pitch has used its ${d.pocMaxBuildsPerPitch} builds.`}
      </Text>
      {left > 0 ? <CopyCommand command={`archangel pitch poc ${row.repo} ${row.issueNumber}`} /> : null}
    </Flex>
  );
  return (
    <Section inner gap="3">
      <Text textStyle="body13" color="fg.subtle">Try it</Text>
      {poc === null ? ask : null}
      {poc?.state.kind === "building" ? <Text textStyle="body13" color="fg">Building a PoC. It counts as build {poc.builds} of {d.pocMaxBuildsPerPitch} for this pitch.</Text> : null}
      {poc?.state.kind === "failed" ? (
        <>
          <Text textStyle="body13" color="fg">The last build failed: {POC_FAILURES[poc.state.category]}.</Text>
          {ask}
        </>
      ) : null}
      {poc?.state.kind === "running" && poc.previewUrl ? (
        <Flex direction="column" gap="2" align="flex-start">
          <Text textStyle="body13" color="fg">
            Running in a sandbox with no network except this machine. Expires in {Math.max(0, Math.ceil((poc.state.expiresAt - now) / 60_000))} min.
          </Text>
          <LinkButton href={poc.previewUrl} primary external>
            Open preview
          </LinkButton>
        </Flex>
      ) : null}
      {poc?.state.kind === "ready" || poc?.state.kind === "stopped" ? (
        <>
          {poc.state.kind === "stopped" ? <Text textStyle="body13" color="fg">The preview stopped: {STOPPED[poc.state.reason]}. The screenshots are kept.</Text> : null}
          <Text textStyle="body13" color="fg">A PoC is built, {poc.builds} of {d.pocMaxBuildsPerPitch} builds used. It is the local ref <Text as="span" textStyle="ref">refs/pitch-poc/{row.issueNumber}</Text> and was never pushed.</Text>
          {row.hasPreview ? <CopyCommand command={`archangel pitch preview ${row.repo} ${row.issueNumber}`} /> : null}
          {poc.diffStat ? <Box as="pre" textStyle="ref" color="fg.muted" borderWidth="1px" borderColor="border" p="3" overflowX="auto">{poc.diffStat}</Box> : null}
          {left > 0 ? ask : null}
        </>
      ) : null}
      {!row.hasPreview ? <Text textStyle="meta" color="fg.subtle">This repo has no preview set up. Add a preview block to .agents/archangel.json so a PoC can be run.</Text> : null}
    </Section>
  );
}

const assetUrl = (a: PitchAttachment) => `/api/pitch-asset/${a.sha256}`;

/** Host-validated images from the repo. Only the stored image is shown, by its hash; captions and paths are React text. */
function Pictures({ items }: { items: PitchAttachment[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const paths = [...new Set(items.filter((a) => a.kind === "repo").map((a) => a.path))];
  return (
    <Section inner gap="3">
      <Flex gap="10" direction={{ base: "column", xl: "row" }} justify="space-between">
        <Box minW="0" maxW="320px">
          <Text textStyle="body13" color="fg.subtle">Pictures, {items.length}</Text>
          {paths.length > 0 ? <Text textStyle="meta" color="fg.muted" mt="1">From the repo</Text> : null}
          {paths.map((path) => (
            <Text key={path} textStyle="ref" color="fg.muted" wordBreak="break-all">{path}</Text>
          ))}
          {items.some((a) => a.kind === "capture") ? <Text textStyle="meta" color="fg.muted" mt="1">Screenshot taken by Archangel</Text> : null}
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
