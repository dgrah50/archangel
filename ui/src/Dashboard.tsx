import { Box, Flex, Link, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import type { HostStatus } from "../../src/core/host-facts.js";
import type { UiItem, UiState } from "../../src/core/ui-state.js";
import type { AccountRow } from "../../src/core/ui-accounts.js";
import { back, resetWords, tightest, useAccounts, usageWords } from "./AccountsPanel";
import { recommendationShort } from "./common";
import { Badge } from "./arc/badge/badge";
import { BarChart } from "./arc/bar-chart/bar-chart";
import { Sparkline } from "./arc/sparkline/sparkline";
import { UsageMeter } from "./arc/usage-meter/usage-meter";
import { CopyCommand, Dot, Group, Line, Page, PageHeadline, type Tone } from "./page";
import { cap, gap, gh, phaseWord, runningOf, ThreadLine } from "./thread-lines";

// Strings from the Ledger (issue titles) are untrusted: they are only ever rendered as React text children,
// never as HTML, and links are only built for repo slugs shaped like owner/name.

/** The autonomy count is "near its cap" from this share of the cap. */
const NEAR_CAP = 0.8;
const RESTART_COMMAND = "archangel daemon restart";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (v: number, digits = 2) => `$${v.toFixed(digits)}`;

/** Overview: the counts, three summary panels, then every Thread on one line, grouped by what it is waiting for. */
export function Dashboard({ state: s, host }: { state: UiState; host: HostStatus | null }) {
  const now = s.generatedAt;
  const landed = s.daily[s.daily.length - 1]?.merged ?? 0;
  const pitches = s.pitches.count;
  const waiting = s.needsYou.length + pitches;
  const running = runningOf(s.groups);
  const plain = (list: UiItem[], tone: Tone) => list.map((i) => <ThreadLine key={`${i.repo}#${i.issueNumber}`} i={i} now={now} tone={tone} meta={phaseWord(i.phase)} pr />);
  const empty = waiting === 0 && Object.values(s.groups).every((l) => l.length === 0);
  return (
    <Page>
      <PageHeadline
        title="Overview"
        right={
          <Flex gap="2" wrap="wrap">
            <Count tone={waiting > 0 ? "owner" : "hollow"}>{waiting > 0 ? `${waiting} need you` : "nothing needs you"}</Count>
            {s.groups.Stuck.length > 0 ? <Count tone="owner">{s.groups.Stuck.length} stuck</Count> : null}
            <Count tone="ink">{running.length} running</Count>
            <Count tone="passed">{landed} landed today</Count>
          </Flex>
        }
      />
      <Flex gap="4" direction={{ base: "column", lg: "row" }} flexShrink={0}>
        <LandedPanel state={s} />
        <LinePanel state={s} />
        <SpendPanel state={s} />
      </Flex>
      <AccountsCard now={now} />
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
                <AnswerLink href={gh(i.repo, i.prNumber ? "pull" : "issues", i.prNumber ?? i.issueNumber)} solid={idx === 0}>
                  Answer on GitHub
                </AnswerLink>
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

const BADGE: Record<Tone, "warning" | "success" | "neutral"> = { owner: "warning", passed: "success", ink: "neutral", hollow: "neutral", ring: "neutral" };

function Count({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge tone={BADGE[tone]} dot={tone !== "hollow"} pill>
      {children}
    </Badge>
  );
}

/** The next move for a decision: a pill that links out to GitHub. The first in the queue is solid. */
function AnswerLink({ href, solid, children }: { href: string; solid?: boolean; children: ReactNode }) {
  return (
    <Link href={href} target="_blank" rel="noreferrer noopener" display="flex" alignItems="center" h="24px" px="2.5" rounded="full" flexShrink={0} textStyle="meta" fontSize="12px" textDecoration="none" _hover={{ textDecoration: "none", borderColor: "fg.subtle" }} {...(solid ? { bg: "fg", color: "bg", fontWeight: "500" } : { borderWidth: "1px", borderColor: "border", color: "fg.muted" })}>
      {children}
    </Link>
  );
}

/** A thin bar: how much of an allowance is used. Amber from 90%. */
function Bar({ fraction }: { fraction: number }) {
  const f = Math.min(1, Math.max(0, fraction));
  return (
    <Box h="6px" rounded="full" bg="bg.muted" overflow="hidden" flex="1" minW="80px">
      <Box h="full" rounded="full" bg={f >= 0.9 ? "owner" : "fg"} w={`${Math.round(f * 100)}%`} />
    </Box>
  );
}

const ROLE_WORD: Record<string, string> = { implement: "build", revise: "revise", rebase: "rebase", review: "review" };

/** One row per account on this machine: whether it can take work, and how much of today's allowance it has used. Absent when the dashboard cannot read accounts (remote mode). */
function AccountsCard({ now }: { now: number }) {
  const { data } = useAccounts();
  if (!data || data.state !== "ok") return null;
  return (
    <Box mt="4" flexShrink={0}>
      <Panel>
        <Flex align="baseline" justify="space-between" pb="2">
          <Text textStyle="body13" color="fg.muted">
            Accounts
          </Text>
          <Link href="#/settings" textStyle="meta" color="fg.muted">
            Configure
          </Link>
        </Flex>
        <Flex direction="column" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
          {data.accounts.map((a) => (
            <AccountLine key={a.id} a={a} now={now} />
          ))}
        </Flex>
      </Panel>
    </Box>
  );
}

function AccountLine({ a, now }: { a: AccountRow; now: number }) {
  const cooling = a.cooldownUntil !== null && a.cooldownUntil > now;
  const idle = a.roles.length === 0;
  const capped = a.maxAttemptsPerDay !== null;
  const today = `${a.attemptsToday} ${a.attemptsToday === 1 ? "attempt" : "attempts"} today`;
  return (
    <Flex align="center" columnGap="4" rowGap="1" minH="44px" py="2" wrap={{ base: "wrap", lg: "nowrap" }}>
      <Flex direction="column" w={{ lg: "250px" }} flexShrink={0} minW="0">
        <Text textStyle="command" fontSize="13px" color="fg" truncate>
          {a.id}
        </Text>
        <Text textStyle="meta" color="fg.subtle" truncate>
          {a.provider}
          {idle ? "" : ` · ${a.roles.map((r) => ROLE_WORD[r] ?? r).join(", ")}`}
        </Text>
      </Flex>
      <Box w={{ lg: "220px" }} flexShrink={0}>
        <Badge tone={cooling ? "warning" : idle ? "neutral" : "success"} dot pill>
          {cooling ? `Hit its limit, back in ${back(a.cooldownUntil! - now)}` : idle ? "Not in any chain" : "Ready"}
        </Badge>
      </Box>
      <Flex align="center" gap="3" flex="1" minW="180px">
        {capped ? <Bar fraction={a.attemptsToday / a.maxAttemptsPerDay!} /> : a.usage ? <Bar fraction={tightest(a.usage).usedPercent / 100} /> : <Box flex="1" />}
        <Text textStyle="body13" color="fg" whiteSpace={a.usage && !capped ? "normal" : "nowrap"}>
          {capped ? `${a.attemptsToday} of ${a.maxAttemptsPerDay} attempts today` : a.usage ? `${usageWords(a.usage)} used` : today}
        </Text>
      </Flex>
      <Text textStyle="meta" color="fg.subtle" w={{ lg: "230px" }} textAlign={{ lg: "end" }} flexShrink={0}>
        {a.usage && !capped ? [resetWords(a.usage, now), `read ${gap(now - a.usage.observedAt)} ago`].filter(Boolean).join(" · ") : a.lastUsedAt ? `last used ${gap(now - a.lastUsedAt)} ago` : "not used yet"}
      </Text>
    </Flex>
  );
}

/** A summary card: Arc's resting surface (panel fill, hairline border, surface radius). */
function Panel({ children }: { children: ReactNode }) {
  return (
    <Flex direction="column" flex="1" minW="0" bg="bg.panel" borderWidth="1px" borderColor="border" rounded="surface" p="5">
      {children}
    </Flex>
  );
}

const dayLabel = (key: string, opts: Intl.DateTimeFormatOptions) => new Date(`${key}T12:00:00`).toLocaleDateString("en-GB", opts);

function LandedPanel({ state: s }: { state: UiState }) {
  const data = s.daily.map((d, i) => ({ key: d.day, label: dayLabel(d.day, { weekday: "short", day: "numeric", month: "short" }), axisLabel: i % 3 === 1 ? dayLabel(d.day, { day: "numeric", month: "short" }) : undefined, value: d.merged }));
  return (
    <Panel>
      <BarChart data={data} label="Fixes landed" period="Last 14 days" averageLabel="Landed per day" valueLabel="Landed" height={188} formatValue={(v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))} />
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
    <Panel>
      <Text textStyle="body13" color="fg.muted" pb="3">
        On the line
      </Text>
      {stations.map((st) => (
        <Flex key={st.label} align="center" gap="3" h="30px" flexShrink={0}>
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
      <Box borderTopWidth="1px" borderColor="border" mt="4" pt="4" flex="1">
        <CostTrend state={s} />
      </Box>
    </Panel>
  );
}

/** Per day: that day's metered spend over the fixes that landed that day. */
function CostTrend({ state: s }: { state: UiState }) {
  const cost = s.outcomes.costUsdPerFix;
  const days = s.daily.map((d, i) => ({ day: d.day, v: d.merged > 0 ? s.spend.daily[i]!.usd / d.merged : null })).filter((d): d is { day: string; v: number } => d.v !== null);
  return days.length > 1 ? (
    <Sparkline data={days.map((d) => d.v)} labels={days.map((d) => dayLabel(d.day, { day: "numeric", month: "short" }))} label="Cost per merged fix" value={cost === null ? undefined : usd(cost)} formatValue={(n) => usd(n)} height={44} area />
  ) : (
    <Stat label="Cost per merged fix" value={cost === null ? "n/a" : usd(cost)} />
  );
}

function SpendPanel({ state: s }: { state: UiState }) {
  const { todayUsd, capUsd } = s.spend;
  const v = Object.values(s.outcomes.vendorAgreement);
  const approved = v.reduce((n, a) => n + a.approvedMerges, 0);
  const agreed = v.reduce((n, a) => n + a.undisputed, 0);
  return (
    <Panel>
      <Flex direction="column" gap="4" flex="1" justify="space-between">
        {capUsd === null ? (
          <Stat label="Spent today" value={usd(todayUsd)} note="daily cap unavailable" />
        ) : (
          <UsageMeter label="Spent today" segments={[{ id: "metered", label: "Metered API", value: todayUsd }]} limit={capUsd} unit="USD" decimals={2} freeLabel="Left today" overLabel="Over the cap" />
        )}
        <Box borderTopWidth="1px" borderColor="border" pt="4">
          <Stat label="Verdicts you agreed with" value={approved === 0 ? "n/a" : `${Math.round((agreed / approved) * 100)}%`} note={approved === 0 ? "none reviewed yet" : `${agreed} of ${approved}`} />
        </Box>
      </Flex>
    </Panel>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Flex align="baseline" gap="3">
      <Text textStyle="body13" color="fg.muted" flex="1" whiteSpace="nowrap">
        {label}
      </Text>
      {note ? (
        <Text textStyle="meta" color="fg.subtle">
          {note}
        </Text>
      ) : null}
      <Text textStyle="label" color={value === "n/a" ? "fg.subtle" : "fg"}>
        {value}
      </Text>
    </Flex>
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
