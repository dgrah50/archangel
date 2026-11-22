import { Badge, Box, Card, Heading, Link, SimpleGrid, Stack, Table, Text } from "@chakra-ui/react";
import type { UiItem, UiState } from "../../src/core/ui-state.js";

// Strings from the Ledger (issue titles) are untrusted: they are only ever rendered as React text children,
// never as HTML, and links are only built for repo slugs shaped like owner/name.

const STAGES = Object.keys({
  "Working": 0,
  "Waiting on CI": 0,
  "In review": 0,
  "Ready for owner": 0,
  "Needs you": 0,
  "Owner driving": 0,
  "Queued": 0,
  "Done in last 7 days": 0,
}) as Array<keyof UiState["stages"]>;

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

function ItemRow({ i, now }: { i: UiItem; now: number }) {
  return (
    <Text>
      <GhLink repo={i.repo} kind="issues" num={i.issueNumber}>{`${i.repo}#${i.issueNumber}`}</GhLink>
      {i.prNumber ? (
        <>
          {" ("}
          <GhLink repo={i.repo} kind="pull" num={i.prNumber}>{`PR #${i.prNumber}`}</GhLink>
          {")"}
        </>
      ) : null}{" "}
      {i.title}{" "}
      <Text as="span" color="fg.muted" textStyle="sm">
        {i.phase}, {age(now - i.since)}
      </Text>
    </Text>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box as="section" mt="10">
      <Heading size="lg" mb="4">
        {title}
      </Heading>
      {children}
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
        <svg role="img" aria-label={`${label}, last ${values.length} days`} width="100%" viewBox={`0 0 ${values.length * w} 48`} preserveAspectRatio="none">
          {values.map((v, idx) => (
            <rect key={days[idx] ?? idx} x={idx * w + 2} y={44 - (v / max) * 40} width={w - 4} height={Math.max(v > 0 ? 2 : 0, (v / max) * 40)} rx="2" fill="currentColor" opacity={0.8}>
              <title>{`${days[idx] ?? ""}: ${v}`}</title>
            </rect>
          ))}
        </svg>
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
  return (
    <Box maxW="64rem" mx="auto" p="6">
      <Heading size="2xl">Archangel</Heading>
      <Text color="fg.muted" textStyle="sm">
        Read-only. Approvals and merges happen on GitHub. Updated {new Date(s.generatedAt).toISOString()}.
      </Text>

      <Section title="Needs You">
        {s.needsYou.length === 0 ? (
          <Text color="fg.muted">Nothing needs you.</Text>
        ) : (
          <Stack gap="3">
            {s.needsYou.map((i) => (
              <Card.Root key={`${i.repo}#${i.issueNumber}`}>
                <Card.Body>
                  <Text>
                    <GhLink repo={i.repo} kind="issues" num={i.issueNumber}>{`${i.repo}#${i.issueNumber}`}</GhLink> {i.title}
                  </Text>
                  <Text color="fg.muted" textStyle="sm">
                    <Badge mr="2">{i.decisionClass}</Badge>waiting {age(s.generatedAt - i.since)}
                  </Text>
                  <Text mt="2">{i.recommendation}</Text>
                </Card.Body>
              </Card.Root>
            ))}
          </Stack>
        )}
      </Section>

      <Section title="Threads">
        {STAGES.map((st) => (
          <Box key={st} mb="4">
            <Heading size="md" mb="1">
              {st} ({s.stages[st].length})
            </Heading>
            <Stack gap="1">
              {s.stages[st].map((i) => (
                <ItemRow key={`${i.repo}#${i.issueNumber}`} i={i} now={s.generatedAt} />
              ))}
            </Stack>
          </Box>
        ))}
      </Section>

      <Section title="Outcomes (all time, per merged fix)">
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

      <Section title="Scout activity">
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
