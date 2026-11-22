import { Box, Card, Heading, SimpleGrid, Stat, Table, Text } from "@chakra-ui/react";
import { correctionCategories } from "../../src/core/corrections.js";
import type { UiState } from "../../src/core/ui-state.js";
import { GhLink } from "./common";

// Strings from the Ledger (issue titles) are untrusted: they are only ever rendered as React text children,
// never as HTML, and links are only built for repo slugs shaped like owner/name.

const n = (v: number | null, unit = "") => (v === null ? "n/a" : `${Math.round(v * 10) / 10}${unit}`);

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
                Owner corrections (last {s.corrections.windowDays ?? 30} days)
              </Text>
              {correctionCategories(s.corrections).filter((c) => c.count > 0).length === 0 ? <Text>none</Text> : null}
              {correctionCategories(s.corrections)
                .filter((c) => c.count > 0)
                .map((c) => (
                  <Text key={c.category}>
                    {c.category}: {c.count}
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
