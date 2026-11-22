import { Badge, Box, Card, Heading, Link, SimpleGrid, Stack, Stat, Table, Text } from "@chakra-ui/react";
import type { UiItem, UiState } from "../../src/core/ui-state.js";

// Strings from the Ledger (issue titles) are untrusted: they are only ever rendered as React text children,
// never as HTML, and links are only built for repo slugs shaped like owner/name.

// "Needs you" is shown prominently above; "Done" is collapsed behind its count.
const ACTIVE_STAGES = ["Working", "Waiting on CI", "In review", "Ready for owner", "Owner driving", "Queued"] as const satisfies ReadonlyArray<keyof UiState["stages"]>;

const STATUS_PALETTE: Record<string, string> = {
  working: "blue",
  awaiting_gate: "yellow",
  reviewing: "purple",
  landing: "purple",
  shadow_ready: "green",
  owner_driving: "cyan",
  queued: "gray",
  merged: "green",
  "owner merged": "green",
  "PR closed": "gray",
  abandoned: "gray",
  reverted: "red",
};

function age(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const n = (v: number | null, unit = "") => (v === null ? "n/a" : `${Math.round(v * 10) / 10}${unit}`);

function GhLink({ repo, kind, num, children }: { repo: string; kind: "issues" | "pull"; num: number; children: string }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return <>{children}</>;
  return (
    <Link href={`https://github.com/${repo}/${kind}/${num}`} rel="noreferrer noopener" target="_blank">
      {children}
    </Link>
  );
}

function ThreadTable({ items, now }: { items: UiItem[]; now: number }) {
  return (
    <Table.Root size="sm" variant="line">
      <Table.Body>
        {items.map((i) => (
          <Table.Row key={`${i.repo}#${i.issueNumber}`}>
            <Table.Cell whiteSpace="nowrap">
              <GhLink repo={i.repo} kind="issues" num={i.issueNumber}>{`${i.repo}#${i.issueNumber}`}</GhLink>
              {i.prNumber ? (
                <>
                  {" "}
                  <GhLink repo={i.repo} kind="pull" num={i.prNumber}>{`PR #${i.prNumber}`}</GhLink>
                </>
              ) : null}
            </Table.Cell>
            <Table.Cell>{i.title}</Table.Cell>
            <Table.Cell whiteSpace="nowrap">
              <Badge colorPalette={STATUS_PALETTE[i.phase] ?? "gray"}>{i.phase.replace(/_/g, " ")}</Badge>
            </Table.Cell>
            <Table.Cell whiteSpace="nowrap" color="fg.muted" textAlign="end">
              {age(now - i.since)}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

function StatTile({ label, value, help }: { label: string; value: string | number; help?: string }) {
  return (
    <Card.Root>
      <Card.Body py="3">
        <Stat.Root>
          <Stat.Label>{label}</Stat.Label>
          <Stat.ValueText>{value}</Stat.ValueText>
          {help ? <Stat.HelpText>{help}</Stat.HelpText> : null}
        </Stat.Root>
      </Card.Body>
    </Card.Root>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Box as="section" mt="12">
      <Heading size="lg">{title}</Heading>
      {hint ? (
        <Text color="fg.muted" textStyle="sm">
          {hint}
        </Text>
      ) : null}
      <Box mt="4">{children}</Box>
    </Box>
  );
}

/** Plain SVG bars: no chart dependency. */
function Bars({ label, values, days }: { label: string; values: number[]; days: string[] }) {
  const max = Math.max(1, ...values);
  const w = 14;
  return (
    <Card.Root>
      <Card.Body>
        <Text fontWeight="medium">{label}</Text>
        <Box color="blue.solid">
        <svg role="img" aria-label={`${label}, last ${values.length} days`} width="100%" viewBox={`0 0 ${values.length * w} 48`} preserveAspectRatio="none">
          {values.map((v, idx) => (
            <rect key={days[idx] ?? idx} x={idx * w + 2} y={44 - (v / max) * 40} width={w - 4} height={Math.max(v > 0 ? 2 : 0, (v / max) * 40)} rx="2" fill="currentColor" opacity={0.8}>
              <title>{`${days[idx] ?? ""}: ${v}`}</title>
            </rect>
          ))}
        </svg>
        </Box>
        <Box display="flex" justifyContent="space-between" color="fg.muted" textStyle="xs">
          <span>{days[0]?.slice(5)}</span>
          <span>{days[days.length - 1]?.slice(5)}</span>
        </Box>
        <Text color="fg.muted" textStyle="sm">
          total {values.reduce((a, b) => a + b, 0)}
        </Text>
      </Card.Body>
    </Card.Root>
  );
}

export function Dashboard({ state: s }: { state: UiState }) {
  const o = s.outcomes;
  const repos = Object.keys(s.autonomySteps);
  const mergedToday = s.daily[s.daily.length - 1]?.merged ?? 0;
  const done = s.stages["Done in last 7 days"];
  const activeCount = ACTIVE_STAGES.reduce((t, st) => t + s.stages[st].length, 0);
  return (
    <Box maxW="64rem" mx="auto" p="6">
      <Heading size="2xl">Archangel</Heading>
      <Text color="fg.muted" textStyle="sm">
        Read-only. Approvals and merges happen on GitHub. Updated {new Date(s.generatedAt).toISOString()}.
      </Text>

      <SimpleGrid columns={{ base: 2, md: 3 }} gap="3" mt="6">
        <StatTile label="Repos" value={repos.length} />
        <StatTile label="Merged today" value={mergedToday} />
        <StatTile label="Needs You" value={s.needsYou.length} help={s.needsYou.length === 0 ? "all clear" : "waiting on you"} />
        {repos.map((r) => (
          <StatTile key={r} label={r} value={s.autonomySteps[r] ?? 0} help="autonomous steps since owner" />
        ))}
      </SimpleGrid>

      <Section title="Needs You">
        {s.needsYou.length === 0 ? (
          <Box borderWidth="1px" borderStyle="dashed" rounded="xl" p="5" color="fg.muted" textAlign="center">
            Nothing needs you.
          </Box>
        ) : (
          <Stack gap="3">
            {s.needsYou.map((i) => (
              <Card.Root key={`${i.repo}#${i.issueNumber}`} borderLeftWidth="4px" borderLeftColor="orange.solid">
                <Card.Body>
                  <Text fontWeight="medium">
                    <GhLink repo={i.repo} kind="issues" num={i.issueNumber}>{`${i.repo}#${i.issueNumber}`}</GhLink> {i.title}
                  </Text>
                  <Text color="fg.muted" textStyle="sm" mt="1">
                    <Badge colorPalette="orange" mr="2">
                      {i.decisionClass}
                    </Badge>
                    waiting {age(s.generatedAt - i.since)}
                  </Text>
                  <Text mt="2">{i.recommendation}</Text>
                </Card.Body>
              </Card.Root>
            ))}
          </Stack>
        )}
      </Section>

      <Section title="Threads" hint={`${activeCount} in flight, ${done.length} finished in the last 7 days`}>
        {activeCount === 0 ? <Text color="fg.muted">No Threads in flight.</Text> : null}
        {ACTIVE_STAGES.filter((st) => s.stages[st].length > 0).map((st) => (
          <Box key={st} mb="5">
            <Heading size="md" mb="1">
              {st}{" "}
              <Badge variant="subtle" ml="1">
                {s.stages[st].length}
              </Badge>
            </Heading>
            <ThreadTable items={s.stages[st]} now={s.generatedAt} />
          </Box>
        ))}
        {done.length > 0 ? (
          <Box as="details" borderWidth="1px" rounded="xl" px="4" py="2">
            <Box as="summary" cursor="pointer" fontWeight="medium" py="1">
              Done in last 7 days{" "}
              <Badge variant="subtle" ml="1">
                {done.length}
              </Badge>
            </Box>
            <ThreadTable items={done} now={s.generatedAt} />
          </Box>
        ) : null}
      </Section>

      <Section title="Outcomes" hint="All time, per merged fix. Merge count is volume, not success.">
        <Text mb="3">
          Merged fixes: {o.mergedFixes}{" "}
          <Text as="span" color="fg.muted">
            (volume)
          </Text>
        </Text>
        <SimpleGrid columns={{ base: 1, md: 2 }} gap="3">
          <Card.Root>
            <Card.Body>
              <Text>
                Metered cost: {o.costUsdPerFix === null ? "n/a" : `$${o.costUsdPerFix.toFixed(2)}`} (total ${o.meteredUsdTotal.toFixed(2)}; subscription runs count $0)
              </Text>
              <Text>
                Attempts: {n(o.attemptsPerFix)}, attempt time {n(o.attemptMinutesPerFix, "m")}
              </Text>
              <Text>
                Reverts: {n(o.revertsPerFix)} ({o.reverts})
              </Text>
              <Text>
                Rework: {n(o.reworkAttemptsPerFix)} extra attempts ({o.reworkAttemptsTotal} total)
              </Text>
            </Card.Body>
          </Card.Root>
          <Card.Root>
            <Card.Body>
              <Text fontWeight="medium">Vendor agreement with owner</Text>
              {Object.keys(o.vendorAgreement).length === 0 ? <Text>n/a</Text> : null}
              {Object.entries(o.vendorAgreement).map(([v, a]) => (
                <Text key={v}>
                  {v}: {a.rate === null ? "n/a" : `${Math.round(a.rate * 100)}%`} ({a.undisputed}/{a.approvedMerges})
                </Text>
              ))}
              <Text fontWeight="medium" mt="3">
                Autonomy
              </Text>
              {Object.keys(s.autonomySteps).length === 0 ? <Text>n/a</Text> : null}
              {Object.entries(s.autonomySteps).map(([r, c]) => (
                <Text key={r}>
                  {r}: {c} autonomous steps since owner
                </Text>
              ))}
            </Card.Body>
          </Card.Root>
          <Bars label="Merged fixes per day" values={s.daily.map((d) => d.merged)} days={s.daily.map((d) => d.day)} />
          <Bars label="Rework attempts per day" values={s.daily.map((d) => d.reworkAttempts)} days={s.daily.map((d) => d.day)} />
        </SimpleGrid>
      </Section>

      <Section title="Scout activity" hint="Most recent Scout proposals.">
        {s.scouts.length === 0 ? (
          <Text color="fg.muted">No Scout proposals.</Text>
        ) : (
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>Repo</Table.ColumnHeader>
                <Table.ColumnHeader>Issue</Table.ColumnHeader>
                <Table.ColumnHeader>Scout</Table.ColumnHeader>
                <Table.ColumnHeader>Auto-promoted</Table.ColumnHeader>
                <Table.ColumnHeader>Has Thread</Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {s.scouts.map((p) => (
                <Table.Row key={`${p.repo}#${p.issueNumber}`}>
                  <Table.Cell>{p.repo}</Table.Cell>
                  <Table.Cell>
                    <GhLink repo={p.repo} kind="issues" num={p.issueNumber}>{`#${p.issueNumber}`}</GhLink>
                  </Table.Cell>
                  <Table.Cell>{p.scoutName}</Table.Cell>
                  <Table.Cell>{p.autoPromoted ? "yes" : "no"}</Table.Cell>
                  <Table.Cell>{p.hasThread ? "yes" : "no"}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
      </Section>
    </Box>
  );
}
