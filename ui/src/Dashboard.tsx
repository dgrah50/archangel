import { Box, Flex, Link, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import type { HostStatus } from "../../src/core/host-facts.js";
import type { UiItem, UiState } from "../../src/core/ui-state.js";
import { age, recommendationShort } from "./common";
import { CopyCommand, Dot, Meter, Page, PageHeadline, Ref, Sparkline } from "./page";
import { threadHash } from "./route";

// Strings from the Ledger (issue titles) are untrusted: they are only ever rendered as React text children,
// never as HTML, and links are only built for repo slugs shaped like owner/name.

/** The autonomy count is "near its cap" from this share of the cap. */
const NEAR_CAP = 0.8;
const RESTART_COMMAND = "archangel daemon restart";
const SLUG = /^[\w.-]+\/[\w.-]+$/;

const gap = (ms: number) => age(ms).replace(/(\d)([a-z])/, "$1 $2");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (v: number, digits = 2) => `$${v.toFixed(digits)}`;
const gh = (repo: string, kind: "issues" | "pull", num: number) => `https://github.com/${repo}/${kind}/${num}`;
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

type Tone = "ink" | "owner" | "passed" | "hollow" | "ring";
/** Phase names as the owner says them. */
const PHASE: Record<string, string> = { working: "working", awaiting_gate: "at the Gate", reviewing: "in review", landing: "landing", shadow_ready: "passed review", awaiting_plan: "plan waiting for your approval" };

/** Overview: the counts, three summary panels, then every Thread on one line, grouped by what it is waiting for. */
export function Dashboard({ state: s, host }: { state: UiState; host: HostStatus | null }) {
  const now = s.generatedAt;
  const landed = s.daily[s.daily.length - 1]?.merged ?? 0;
  const pitches = s.pitches.count;
  const waiting = s.needsYou.length + pitches;
  const running = [...s.groups.Working, ...s.groups["Waiting on CI"], ...s.groups["In review"]].sort((a, b) => b.since - a.since);
  const plain = (list: UiItem[], tone: Tone) => list.map((i) => <ThreadLine key={`${i.repo}#${i.issueNumber}`} i={i} now={now} tone={tone} meta={i.phase === "queued" ? "" : (PHASE[i.phase] ?? i.phase.replace(/_/g, " "))} />);
  const empty = waiting === 0 && Object.values(s.groups).every((l) => l.length === 0);
  return (
    <Page>
      <Flex justify="space-between" align="baseline" columnGap="6" wrap="wrap">
        <PageHeadline title="Overview" />
        <Flex gap="5" pb="5" wrap="wrap">
          <Count tone={waiting > 0 ? "owner" : "hollow"}>{waiting > 0 ? `${waiting} need you` : "nothing needs you"}</Count>
          {s.groups.Stuck.length > 0 ? <Count tone="owner">{s.groups.Stuck.length} stuck</Count> : null}
          <Count tone="ink">{running.length} running</Count>
          <Count tone="passed">{landed} landed today</Count>
        </Flex>
      </Flex>
      <Flex gap="4" direction={{ base: "column", lg: "row" }} flexShrink={0}>
        <LandedPanel state={s} />
        <LinePanel state={s} />
        <SpendPanel state={s} />
      </Flex>
      <StopsNext state={s} host={host} />
      <Flex direction="column" gap="1" pt="7" flexShrink={0}>
        <Group label="Needs you" n={waiting} tone="owner">
          {s.needsYou.map((i, idx) => (
            <ThreadLine
              key={`${i.repo}#${i.issueNumber}`}
              i={i}
              now={now}
              tone="owner"
              meta={`${cap(i.decisionClass)} · ${recommendationShort(i)}`}
              chip={
                <Chip href={gh(i.repo, i.prNumber ? "pull" : "issues", i.prNumber ?? i.issueNumber)} solid={idx === 0}>
                  Answer on GitHub
                </Chip>
              }
            />
          ))}
          {pitches > 0 ? (
            <Line tone="owner" href="#/pitches" title={`${plural(pitches, "pitch", "pitches")} from Scouts ${pitches === 1 ? "needs" : "need"} a yes or a no`} meta={s.pitches.items.map((p) => p.title).join(" · ")} when={gap(now - s.pitches.items[0]!.filedAt)} />
          ) : null}
        </Group>
        <Group label="Stuck" n={s.groups.Stuck.length} tone="owner">
          {plain(s.groups.Stuck, "owner")}
        </Group>
        <Group label="Ready for you to merge" n={s.groups["Ready for owner"].length} tone="ring">
          {plain(s.groups["Ready for owner"], "ring")}
        </Group>
        <Group label="Running" n={running.length} tone="ink">
          {plain(running, "ink")}
        </Group>
        <Group label="Queued" n={s.groups.Queued.length} tone="hollow">
          {plain(s.groups.Queued, "hollow")}
        </Group>
        <Group label="Landed in the last 7 days" n={s.groups["Done in last 7 days"].length} tone="passed" folded>
          {plain(s.groups["Done in last 7 days"], "passed")}
        </Group>
        {empty ? (
          <Text textStyle="body13" color="fg.muted" px="3">
            No Threads yet. Label an owner-authored issue ready-for-agent to start one.
          </Text>
        ) : null}
      </Flex>
    </Page>
  );
}

function Count({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Flex align="center" gap="2">
      <Dot tone={tone} />
      <Text textStyle="body13" color="fg.muted">
        {children}
      </Text>
    </Flex>
  );
}

/** A group of Threads under a filled header band; folds like the native disclosure it is. Absent when empty. */
function Group({ label, n, tone, folded, children }: { label: string; n: number; tone: Tone; folded?: boolean; children: ReactNode }) {
  if (n === 0) return null;
  return (
    <Box as="details" {...{ open: !folded }} css={{ "&[open] > summary > svg": { transform: "rotate(90deg)" } }}>
      <Flex as="summary" align="center" gap="2.5" h="36px" px="3" rounded="10px" bg="bg.subtle" cursor="pointer" listStyleType="none" css={{ "&::-webkit-details-marker": { display: "none" } }}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ flexShrink: 0, color: "var(--chakra-colors-fg-subtle)" }}>
          <path d="M3.5 1.5L7 5L3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <Dot tone={tone} />
        <Text textStyle="label" color="fg">
          {label}
        </Text>
        <Text textStyle="body13" color="fg.subtle">
          {n}
        </Text>
      </Flex>
      <Box py="1">{children}</Box>
    </Box>
  );
}

/** One line: status dot, title, grey context, an optional chip, and how long it has been there. The title links to `href`. */
function Line({ tone, href, title, meta, chip, when }: { tone: Tone; href?: string; title: string; meta: ReactNode; chip?: ReactNode; when: string }) {
  const text = (
    <>
      <Text as="span" textStyle="label" color="fg" truncate flexShrink={0} maxW="64%">
        {title}
      </Text>
      <Text as="span" textStyle="meta" color="fg.muted" truncate minW="0">
        {meta}
      </Text>
    </>
  );
  return (
    <Flex align="center" gap="2.5" h="40px" ps="34px" pe="3" rounded="10px" _hover={{ bg: "bg.subtle" }}>
      <Dot tone={tone} />
      {href ? (
        <Link href={href} display="flex" alignItems="baseline" gap="2.5" flex="1" minW="0" color="inherit" textDecoration="none" _hover={{ textDecoration: "none" }}>
          {text}
        </Link>
      ) : (
        <Flex align="baseline" gap="2.5" flex="1" minW="0">
          {text}
        </Flex>
      )}
      {chip}
      <Text textStyle="meta" color="fg.subtle" w="40px" textAlign="end" flexShrink={0}>
        {when}
      </Text>
    </Flex>
  );
}

function ThreadLine({ i, now, tone, meta, chip }: { i: UiItem; now: number; tone: Tone; meta: string; chip?: ReactNode }) {
  const ok = SLUG.test(i.repo);
  return (
    <Line
      tone={tone}
      href={ok ? threadHash({ repo: i.repo, issue: i.issueNumber }) : undefined}
      title={i.title}
      meta={
        <>
          <Ref repo={i.repo} num={i.issueNumber} />
          {meta ? ` · ${meta}` : ""}
        </>
      }
      chip={chip ?? (ok && i.prNumber ? <Chip href={gh(i.repo, "pull", i.prNumber)}>PR #{i.prNumber}</Chip> : undefined)}
      when={gap(now - i.since)}
    />
  );
}

/** A pill that links out to GitHub. */
function Chip({ href, solid, children }: { href: string; solid?: boolean; children: ReactNode }) {
  return (
    <Link href={href} target="_blank" rel="noreferrer noopener" display="flex" alignItems="center" h="24px" px="2.5" rounded="full" flexShrink={0} textStyle="meta" fontSize="12px" textDecoration="none" _hover={{ textDecoration: "none", borderColor: "fg.subtle" }} {...(solid ? { bg: "fg", color: "bg", fontWeight: "500" } : { borderWidth: "1px", borderColor: "border", color: "fg.muted" })}>
      {children}
    </Link>
  );
}

/** A summary panel: a grey label over a filled block. */
function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex direction="column" gap="2" flex="1" minW="0">
      <Text textStyle="meta" color="fg.muted" px="3">
        {label}
      </Text>
      <Flex direction="column" flex="1" bg="bg.subtle" rounded="14px" px="4" py="3">
        {children}
      </Flex>
    </Flex>
  );
}

function LandedPanel({ state: s }: { state: UiState }) {
  const total = s.daily.reduce((n, d) => n + d.merged, 0);
  const top = Math.max(1, ...s.daily.map((d) => d.merged));
  return (
    <Panel label="Landed">
      <Flex align="baseline" gap="2.5">
        <Text textStyle="figure" color={total === 0 ? "fg.subtle" : "fg"}>
          {total}
        </Text>
        <Text textStyle="meta" color="fg.muted">
          last 14 days
        </Text>
      </Flex>
      <Flex align="flex-end" justify="space-between" gap="4px" flex="1" minH="88px" pt="3" role="img" aria-label="Fixes landed per day, last 14 days">
        {s.daily.map((d) => (
          <Box key={d.day} title={`${d.day}: ${d.merged}`} flex="1" maxW="10px" rounded="3px" bg={d.merged === 0 ? "border.emphasized" : "fg"} h={d.merged === 0 ? "3px" : `${(d.merged / top) * 100}%`} />
        ))}
      </Flex>
    </Panel>
  );
}

/** Where every Thread is on the line. Solid = the factory is acting; a ring = waiting, not blocked. */
function LinePanel({ state: s }: { state: UiState }) {
  const stations: Array<{ label: string; list: UiItem[]; tone: Tone }> = [
    { label: "Queued", list: s.stages.Queued, tone: "hollow" },
    { label: "Working", list: s.stages.Working, tone: "ink" },
    { label: "Gate", list: s.stages["Waiting on CI"], tone: "ink" },
    { label: "Review", list: s.stages["In review"], tone: "ink" },
    { label: "Ready for you to merge", list: s.stages["Ready for owner"], tone: "ring" },
  ];
  return (
    <Panel label="On the line">
      {stations.map((st) => (
        <Flex key={st.label} align="center" gap="3" flex="1" minH="26px">
          <Text textStyle="body13" color={st.list.length === 0 ? "fg.subtle" : "fg"} w="150px" flexShrink={0}>
            {st.label}
          </Text>
          <Flex gap="5px" flex="1" minW="0" overflow="hidden">
            {st.list.slice(0, 8).map((i) => (
              <Dot key={`${i.repo}#${i.issueNumber}`} tone={st.tone} />
            ))}
          </Flex>
          <Text textStyle="meta" color="fg.subtle" flexShrink={0}>
            {st.list.length > 0 ? `oldest ${gap(s.generatedAt - Math.min(...st.list.map((i) => i.since)))}` : ""}
          </Text>
          <Text textStyle="body13" color={st.list.length === 0 ? "fg.subtle" : "fg"} w="18px" textAlign="end" flexShrink={0}>
            {st.list.length}
          </Text>
        </Flex>
      ))}
    </Panel>
  );
}

function SpendRow({ label, value, hint, children }: { label: string; value: ReactNode; hint: string; children?: ReactNode }) {
  return (
    <Flex align="center" gap="3" flex="1" minH="44px" title={hint} css={{ "& + &": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
      <Text textStyle="body13" color="fg" flexShrink={0}>
        {label}
      </Text>
      <Flex flex="1" minW="0" justify="flex-end" align="center">
        {children}
      </Flex>
      <Text textStyle="body13" color="fg" flexShrink={0} whiteSpace="pre">
        {value}
      </Text>
    </Flex>
  );
}

function SpendPanel({ state: s }: { state: UiState }) {
  const { todayUsd, capUsd } = s.spend;
  const cost = s.outcomes.costUsdPerFix;
  // Per day: that day's metered spend over the fixes that landed that day.
  const trend = s.daily.map((d, i) => (d.merged > 0 ? s.spend.daily[i]!.usd / d.merged : null));
  const v = Object.values(s.outcomes.vendorAgreement);
  const approved = v.reduce((n, a) => n + a.approvedMerges, 0);
  const agreed = v.reduce((n, a) => n + a.undisputed, 0);
  const none = <Text as="span" color="fg.subtle">n/a</Text>;
  return (
    <Panel label="Spend and trust">
      <SpendRow
        label="Spent today"
        hint={capUsd === null ? "Metered API only. The daily cap is unavailable: archangel.yaml could not be read." : `Metered API only. At ${usd(capUsd, 0)} the factory stops until midnight; raise it in Settings.`}
        value={
          <>
            {usd(todayUsd)}
            {capUsd === null ? null : <Text as="span" color="fg.subtle">{` of ${usd(capUsd, 0)}`}</Text>}
          </>
        }
      >
        {capUsd === null ? null : (
          <Flex w="96px">
            <Meter fraction={todayUsd / capUsd} />
          </Flex>
        )}
      </SpendRow>
      <SpendRow label="Cost per merged fix" hint="Subscription runs count $0. Change models in Pipeline." value={cost === null ? none : usd(cost)}>
        <Sparkline values={trend} label="Cost per merged fix, last 14 days" />
      </SpendRow>
      <SpendRow label="Verdicts you agreed with" hint="Reviewed merges you did not dispute: the evidence for letting a repo land on its own." value={approved === 0 ? none : `${Math.round((agreed / approved) * 100)}%`}>
        {approved === 0 ? null : (
          <Text textStyle="meta" color="fg.subtle">
            {agreed} of {approved}
          </Text>
        )}
      </SpendRow>
    </Panel>
  );
}

const heardAt = (ts: number, now: number) => {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? `at ${time}` : `on ${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} at ${time}`;
};

/** "What stops work next, and what clears it": only abnormal things, so it is absent when nothing is about to stop. */
function StopsNext({ state: s, host }: { state: UiState; host: HostStatus | null }) {
  const nearCap = Object.entries(s.autonomyCaps)
    .map(([repo, cap]) => ({ repo, cap, steps: s.autonomySteps[repo] ?? 0 }))
    .filter((r) => r.steps >= Math.ceil(r.cap * NEAR_CAP));
  const restart = host?.restartPending === true;
  if (nearCap.length === 0 && !restart) return null;
  return (
    <Flex direction="column" gap="3" mt="4" px="4" py="3" rounded="14px" bg="bg.subtle" flexShrink={0}>
      {nearCap.map((r) => {
        const name = r.repo.split("/").pop();
        const heard = s.ownerLastHeardAt[r.repo] ?? null;
        return (
          <Flex key={r.repo} direction="column" gap="1">
            <Flex align="baseline" gap="2">
              <Text textStyle="label" color="fg" flex="1">
                {r.steps >= r.cap ? `${name} is paused` : `${name} pauses in ${plural(r.cap - r.steps, "step")}`}
              </Text>
              <Text textStyle="command" color="owner" whiteSpace="pre">
                {r.steps} / {r.cap}
              </Text>
            </Flex>
            <Text textStyle="meta" color="fg.muted">
              It has started {r.steps} Attempts and merges since it last heard from you{heard === null ? "" : ` ${heardAt(heard, s.generatedAt)}`}. Answering a {name} decision, or merging one of its PRs, resets the count.
            </Text>
          </Flex>
        );
      })}
      {restart ? (
        <Flex direction="column" gap="1.5">
          <Text textStyle="label" color="fg">
            Host config changed, not loaded yet
          </Text>
          <CopyCommand command={RESTART_COMMAND} />
        </Flex>
      ) : null}
    </Flex>
  );
}
