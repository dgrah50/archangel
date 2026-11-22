import { Box, Flex, Text } from "@chakra-ui/react";
import type { HostStatus } from "../../src/core/host-facts.js";
import type { UiItem, UiState } from "../../src/core/ui-state.js";
import { age, recommendationShort } from "./common";
import { CopyCommand, LinkButton, Metric, Meter, Owed, Page, PageHeadline, Ref, Row, RowList, Section, Sparkline } from "./page";

// Strings from the Ledger (issue titles) are untrusted: they are only ever rendered as React text children,
// never as HTML, and links are only built for repo slugs shaped like owner/name.

/** The autonomy count is "near its cap" from this share of the cap. */
const NEAR_CAP = 0.8;
const RESTART_COMMAND = "archangel daemon restart";

const gap = (ms: number) => age(ms).replace(/(\d)([a-z])/, "$1 $2");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const usd = (v: number, digits = 2) => `$${v.toFixed(digits)}`;
const ghUrl = (i: UiItem) => `https://github.com/${i.repo}/${i.prNumber ? `pull/${i.prNumber}` : `issues/${i.issueNumber}`}`;

export function Dashboard({ state: s, host }: { state: UiState; host: HostStatus | null }) {
  const stuck = s.groups.Stuck.length;
  const landed = s.daily[s.daily.length - 1]?.merged ?? 0;
  const decisions = s.needsYou.length;
  const pitches = s.pitches.count;
  const waiting = decisions + pitches;
  return (
    <Page>
      <StatusLine state={s} />
      <PageHeadline sub={`${waiting > 0 && stuck === 0 ? "Everything else is moving. " : ""}${landed} landed today, ${stuck === 0 ? "nothing is stuck" : `${stuck} stuck`}.`}>
        {waiting === 0 ? (
          "Nothing is waiting on you."
        ) : (
          <>
            {decisions > 0 ? <Owed>{plural(decisions, "decision")}</Owed> : null}
            {decisions > 0 && pitches > 0 ? " and " : null}
            {pitches > 0 ? <Owed>{plural(pitches, "pitch", "pitches")}</Owed> : null} {waiting === 1 ? "is" : "are"} waiting on you.
          </>
        )}
      </PageHeadline>
      <Flex direction={{ base: "column", lg: "row" }} gap="56px" flexShrink={0}>
        <Box flex="1" minW="0">
          {waiting > 0 ? (
            <RowList>
              {s.needsYou.map((i, idx) => (
                <Row
                  key={`${i.repo}#${i.issueNumber}`}
                  lead={gap(s.generatedAt - i.since)}
                  owed={idx === 0}
                  title={i.title}
                  meta={
                    <>
                      {i.decisionClass.charAt(0).toUpperCase() + i.decisionClass.slice(1)} · <Ref repo={i.repo} num={i.issueNumber} /> · {recommendationShort(i)}
                    </>
                  }
                  action={
                    <LinkButton href={ghUrl(i)} primary={idx === 0} external>
                      {idx === 0 ? "Answer on GitHub" : "Open"}
                    </LinkButton>
                  }
                />
              ))}
              {pitches > 0 ? (
                <Row
                  lead={gap(s.generatedAt - s.pitches.items[0]!.filedAt)}
                  title={`${plural(pitches, "pitch", "pitches")} from Scouts ${pitches === 1 ? "needs" : "need"} a yes or a no`}
                  meta={s.pitches.items.map((p) => p.title).join("  ·  ")}
                  action={<LinkButton href="#/pitches">Review pitches</LinkButton>}
                />
              ) : null}
            </RowList>
          ) : null}
        </Box>
        <StopsNext state={s} host={host} />
      </Flex>
      <LineMap state={s} landed={landed} />
      <Box flex="1" />
      <Flex gap="40px" flexShrink={0} direction={{ base: "column", md: "row" }} pt="8">
        <SpendMetric state={s} />
        <CostMetric state={s} />
        <AgreementMetric state={s} />
      </Flex>
    </Page>
  );
}

function StatusLine({ state: s }: { state: UiState }) {
  const beat = s.daemonHeartbeatAt;
  const live = beat !== null && s.generatedAt - beat <= 3 * 60_000;
  const at = new Date(s.generatedAt);
  const when = `${at.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}, ${at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  const heard = Math.max(0, ...Object.values(s.ownerLastHeardAt).map((v) => v ?? 0));
  const heardAt = new Date(heard);
  const heardDay = heardAt.toDateString() === at.toDateString() ? "" : `${heardAt.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}, `;
  const lastHeard = heard > 0 ? ` · you were last heard from at ${heardDay}${heardAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "";
  return (
    <Flex align="center" gap="2">
      <Box w="7px" h="7px" rounded="full" flexShrink={0} bg={live ? "passed" : "owner"} />
      <Text textStyle="meta" lineHeight="18px" color="fg.subtle">
        {when} · {live ? "daemon running" : "daemon offline"}{lastHeard}
      </Text>
    </Flex>
  );
}

/** "What stops work next, and what clears it": only abnormal things. */
function StopsNext({ state: s, host }: { state: UiState; host: HostStatus | null }) {
  const nearCap = Object.entries(s.autonomyCaps)
    .map(([repo, cap]) => ({ repo, cap, steps: s.autonomySteps[repo] ?? 0 }))
    .filter((r) => r.steps >= Math.ceil(r.cap * NEAR_CAP));
  const restart = host?.restartPending === true;
  return (
    <Section title="What stops work next, and what clears it." w={{ lg: "316px" }} flexShrink={0} gap="14px">
      {nearCap.map((r) => {
        const name = r.repo.split("/").pop();
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
              It has started {r.steps} Attempts and merges since it last heard from you. Answering a {name} decision, or merging one of its PRs, resets the count.
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
      {nearCap.length === 0 && !restart ? (
        <Text textStyle="meta" color="fg.muted">
          Nothing is about to stop the factory.
        </Text>
      ) : null}
    </Section>
  );
}

// The line map: one dot per Thread across the stations. Solid = the factory is acting; hollow = waiting, not blocked; amber siding = Needs you.
const W = 1096;
const STATIONS = 6;
const LINE_Y = 50;
const SIDING_Y = 112;
const INK = "var(--chakra-colors-fg)";
const GREY = "var(--chakra-colors-border-emphasized)";
const TRACK = "var(--chakra-colors-control-rail)";
const AMBER = "var(--chakra-colors-owner)";
const SURFACE = "var(--chakra-colors-bg)";
const stationX = (i: number) => ((i + 0.5) * W) / STATIONS;

type DotKind = "acting" | "waiting-light" | "waiting" | "landed";

function Dots({ n, at, kind }: { n: number; at: number; kind: DotKind }) {
  const small = kind === "landed";
  const shown = Math.min(n, small ? 9 : 7);
  const step = small ? 16 : 22;
  return (
    <>
      {Array.from({ length: shown }, (_, k) => {
        const x = stationX(at) + (k - (shown - 1) / 2) * step;
        if (kind === "acting") return <circle key={k} cx={x} cy={20} r={9} fill={INK} />;
        if (kind === "landed") return <circle key={k} cx={x} cy={22} r={5} fill={GREY} />;
        if (kind === "waiting") return <circle key={k} cx={x} cy={20} r={7.5} fill={SURFACE} stroke={INK} strokeWidth={3} />;
        return <circle key={k} cx={x} cy={20} r={8} fill={SURFACE} stroke={GREY} strokeWidth={2.5} />;
      })}
    </>
  );
}

function LineMap({ state: s, landed }: { state: UiState; landed: number }) {
  const need = s.needsYou.length;
  const oldest = (l: UiItem[]) => (l.length > 0 ? ` · oldest ${gap(s.generatedAt - Math.min(...l.map((i) => i.since)))}` : "");
  const stations: Array<{ label: string; list: UiItem[] | number; kind: DotKind }> = [
    { label: "Queued", list: s.stages.Queued, kind: "waiting-light" },
    { label: "Working", list: s.stages.Working, kind: "acting" },
    { label: "Gate", list: s.stages["Waiting on CI"], kind: "acting" },
    { label: "Review", list: s.stages["In review"], kind: "acting" },
    { label: "Ready for you to merge", list: s.stages["Ready for owner"], kind: "waiting" },
    { label: "Landed today", list: landed, kind: "landed" },
  ];
  return (
    <Box pt="34px" flexShrink={0}>
      <Flex>
        {stations.map((st) => {
          const n = typeof st.list === "number" ? st.list : st.list.length;
          return (
            <Flex key={st.label} direction="column" align="center" flex="1" textAlign="center" textStyle="meta" lineHeight="17px">
              <Text textStyle="label" fontSize="12.5px" lineHeight="17px" color="fg">
                {st.label}
              </Text>
              <Text color="fg.muted">
                {n}
                {typeof st.list === "number" ? "" : oldest(st.list)}
              </Text>
            </Flex>
          );
        })}
      </Flex>
      <Box position="relative" mt="12px">
        <svg viewBox={`0 0 ${W} 140`} width="100%" role="img" aria-label="Where every Thread is on the line" style={{ display: "block" }}>
          <path d={`M20 ${LINE_Y}H1070`} fill="none" stroke={TRACK} strokeWidth="3" strokeLinecap="round" />
          <path d={`M1062 ${LINE_Y - 8}L1073 ${LINE_Y}L1062 ${LINE_Y + 8}`} fill="none" stroke={TRACK} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          {need > 0 ? <path d={`M${stationX(3)} ${LINE_Y}C${stationX(3)} 92 676 ${SIDING_Y} 724 ${SIDING_Y}H800`} fill="none" stroke={AMBER} strokeWidth="3" strokeLinecap="round" /> : null}
          {stations.map((_, i) => (
            <circle key={i} cx={stationX(i)} cy={LINE_Y} r="5.5" fill={SURFACE} stroke={GREY} strokeWidth="2.5" />
          ))}
          {stations.map((st, i) => (
            <Dots key={st.label} n={typeof st.list === "number" ? st.list : st.list.length} at={i} kind={st.kind} />
          ))}
          {need > 0 ? (
            <>
              {Array.from({ length: Math.min(need - 1, 2) }, (_, k) => (
                <circle key={k} cx={742 + k * 26} cy={SIDING_Y} r="9" fill={AMBER} />
              ))}
              <circle cx="800" cy={SIDING_Y} r="12" fill={AMBER} />
              <circle cx="800" cy={SIDING_Y} r="17" fill="none" stroke={AMBER} strokeWidth="1.5" opacity="0.4" />
            </>
          ) : null}
        </svg>
        {need > 0 ? (
          <Flex direction="column" gap="1px" position="absolute" left={`${(828 / W) * 100}%`} top={`${(93 / 140) * 100}%`}>
            <Text textStyle="rowTitle" fontSize="14.5px" lineHeight="20px" color="owner" whiteSpace="pre">
              Needs you · {need}
            </Text>
            <Text textStyle="meta" lineHeight="17px" color="fg.muted" whiteSpace="pre">
              Parked off the line, nothing else waits.
            </Text>
          </Flex>
        ) : null}
        <Flex direction="column" gap="5px" position="absolute" left="0" top={`${(102 / 140) * 100}%`}>
          <Legend solid>The factory is acting</Legend>
          <Legend>Waiting, not blocked</Legend>
        </Flex>
      </Box>
    </Box>
  );
}

function Legend({ solid, children }: { solid?: boolean; children: string }) {
  return (
    <Flex align="center" gap="2">
      <Box w="10px" h="10px" rounded="full" boxSizing="border-box" flexShrink={0} {...(solid ? { bg: "fg" } : { borderWidth: "2.5px", borderColor: "fg" })} />
      <Text textStyle="meta" fontSize="12px" lineHeight="17px" color="fg.subtle">
        {children}
      </Text>
    </Flex>
  );
}

function SpendMetric({ state: s }: { state: UiState }) {
  const { todayUsd, capUsd } = s.spend;
  return (
    <Metric label="Spent today" value={usd(todayUsd)} aside={capUsd === null ? undefined : `of ${usd(capUsd, 0)}`} visual={capUsd === null ? undefined : <Meter fraction={todayUsd / capUsd} />}>
      {capUsd === null ? "Metered API only. The daily cap is unavailable: archangel.yaml could not be read." : `Metered API only. At ${usd(capUsd, 0)} the factory stops until midnight; raise it in Settings.`}
    </Metric>
  );
}

function CostMetric({ state: s }: { state: UiState }) {
  const cost = s.outcomes.costUsdPerFix;
  // Per day: that day's metered spend over the fixes that landed that day.
  const trend = s.daily.map((d, i) => (d.merged > 0 ? s.spend.daily[i]!.usd / d.merged : null));
  const first = trend.find((v) => v !== null) ?? null;
  return (
    <Metric label="Cost per merged fix" value={cost === null ? "n/a" : usd(cost)} visual={<Sparkline values={trend} label="Cost per merged fix, last 14 days" />}>
      {first !== null && cost !== null && first > cost ? `Down from ${usd(first)} two weeks ago. ` : ""}
      Subscription runs count $0. Change models in Pipeline.
    </Metric>
  );
}

function AgreementMetric({ state: s }: { state: UiState }) {
  const v = Object.values(s.outcomes.vendorAgreement);
  const approved = v.reduce((n, a) => n + a.approvedMerges, 0);
  const agreed = v.reduce((n, a) => n + a.undisputed, 0);
  return (
    <Metric label="Would-merge verdicts you agreed with" value={approved === 0 ? "n/a" : `${Math.round((agreed / approved) * 100)}%`}>
      {approved === 0 ? "No reviewed merges yet. " : `${agreed} of ${approved} reviewed merges you did not dispute. `}
      This is the evidence for letting a repo land on its own.
    </Metric>
  );
}
