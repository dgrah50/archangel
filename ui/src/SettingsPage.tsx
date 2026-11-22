import { Badge, Box, Button, Card, Code, Flex, Heading, Link, Stack, Table, Text } from "@chakra-ui/react";
import { useState } from "react";
import { AccountsPanel } from "./AccountsPanel";
import { HostConfigEditor } from "./HostConfigEditor";
import type { SettingsState } from "../../src/core/ui-settings.js";
import type { Feed } from "./AppView";

/** Fixed set of "when it applies" labels (UI-V2-PROPOSAL section 1). Every host field applies only after the daemon restarts today. */
export const APPLY = { restart: "Applies after the daemon restarts", kernel: "Read-only: kernel" } as const;

function Section({ title, apply, children }: { title: string; apply: string; children: React.ReactNode }) {
  return (
    <Box as="section" mt="8">
      <Flex align="center" gap="3" wrap="wrap">
        <Heading size="md">{title}</Heading>
        <Badge colorPalette={apply === APPLY.kernel ? "purple" : "orange"}>{apply}</Badge>
      </Flex>
      <Box mt="3">{children}</Box>
    </Box>
  );
}

function Rows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <Table.Root size="sm" variant="line">
      <Table.Body>
        {rows.map(([k, v]) => (
          <Table.Row key={k}>
            <Table.Cell color="fg.muted" w="14rem">{k}</Table.Cell>
            <Table.Cell>{v}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

const chain = (c: Array<{ provider: string; model?: string }>) => c.map((e) => (e.model ? `${e.provider}:${e.model}` : e.provider)).join(" -> ");

function Machine({ s }: { s: SettingsState }) {
  if (s.host.state !== "ok") {
    const missing = s.host.state === "missing";
    return (
      <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" p="4" mt="6">
        <Text fontWeight="medium">{missing ? "No archangel.yaml." : s.host.state === "invalid" ? "archangel.yaml is invalid." : "archangel.yaml could not be read."}</Text>
        <Text textStyle="sm">{s.host.error}</Text>
        {missing ? <Text textStyle="sm" mt="1">Copy <Code>archangel.example.yaml</Code> to <Code>archangel.yaml</Code> and edit it.</Text> : null}
      </Box>
    );
  }
  const c = s.host.config;
  return (
    <>
      {s.status.restartPending ? (
        <Box role="alert" borderWidth="1px" borderColor="orange.solid" rounded="md" px="3" py="2" mt="4" textStyle="sm">
          This is the file on disk. The daemon loaded an older version: restart it to apply.
        </Box>
      ) : null}
      <Section title="General" apply={APPLY.restart}>
        <Rows rows={[["Timezone", c.dailyTimezone], ["Digest hour", String(c.digestHour)], ["Poll interval", `${c.pollIntervalMs} ms`], ["Data directory", c.dataDir], ["Owner user id", String(c.ownerUserId)]]} />
      </Section>
      <Section title="Models and accounts" apply={APPLY.restart}>
        <Rows rows={[["Auth mode", c.authMode], ...(Object.entries(c.chains) as Array<[string, Array<{ provider: string; model?: string }>]>).map(([role, ch]): [string, React.ReactNode] => [`${role[0]!.toUpperCase()}${role.slice(1)} chain`, chain(ch)]), ["Reviewer chain", chain(c.reviewerChain)], ["Claude model", c.claudeModel], ["OpenAI reviewer model", c.openaiReviewerModel], ["Gemini reviewer model", c.geminiReviewerModel]]} />
      </Section>
      <Section title="Limits" apply={APPLY.restart}>
        <Rows rows={[["Max daily spend", `$${c.maxDailyUsd}`], ["Autonomous steps without owner", String(c.maxAutonomousStepsWithoutOwner)], ["Implement attempts per Thread", String(c.maxImplementAttemptsPerThread)], ["Revisions per Thread", String(c.maxRevisionsPerThread)], ["Rebases per Thread", String(c.maxRebasesPerThread)], ["Implement timeout", `${c.implementTimeoutMs} ms`], ["Gate timeout", `${c.gateTimeoutMs} ms`]]} />
      </Section>
      <Section title="Projects" apply={APPLY.restart}>
        <Table.Root size="sm">
          <Table.Header>
            <Table.Row>
              {["Repo", "Branch", "Shadow mode", "Concurrent", "Auto-merges/day", "Scouts"].map((h) => (
                <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {c.projects.map((p) => (
              <Table.Row key={p.repo}>
                <Table.Cell>{p.repo}</Table.Cell>
                <Table.Cell>{p.defaultBranch}</Table.Cell>
                <Table.Cell>{p.shadowMode ? "on" : "off"}</Table.Cell>
                <Table.Cell>{p.maxConcurrentThreads}</Table.Cell>
                <Table.Cell>{p.maxAutoMergesPerDay}</Table.Cell>
                <Table.Cell>{p.scouts.enabled ? `on (${p.scouts.maxRunsPerDay}/day)` : "off"}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Section>
    </>
  );
}

function Environment({ s }: { s: SettingsState }) {
  const reported = s.status.reported && s.status.envPresence !== null;
  return (
    <Section title="Environment" apply={APPLY.restart}>
      <Text color="fg.muted" textStyle="sm" mb="2">
        {reported ? "Presence as the daemon saw it when it started. Values are never shown." : "The daemon has not reported its environment yet (restart it on this version). Presence is unknown, not unset."}
      </Text>
      <Table.Root size="sm">
        <Table.Body>
          {s.env.map((e) => (
            <Table.Row key={e.name}>
              <Table.Cell><Code>{e.name}</Code></Table.Cell>
              <Table.Cell color="fg.muted">{e.feature}</Table.Cell>
              <Table.Cell>
                <Badge colorPalette={e.set === null ? "gray" : e.set ? "green" : "orange"}>{e.set === null ? "unknown" : e.set ? "set" : "unset"}</Badge>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Section>
  );
}

function Kernel({ s }: { s: SettingsState }) {
  const k = s.kernel;
  return (
    <Section title="Kernel invariants" apply={APPLY.kernel}>
      <Text color="fg.muted" textStyle="sm" mb="2">No config file, repo or dashboard can change these.</Text>
      <Rows rows={[
        ["Gate bounds (maxima)", `${k.maxNonTestLines} non-test lines, ${k.maxTotalLines} total, ${k.maxFiles} files`],
        ["Test runs (minimums)", `base ${k.minBaseTestRuns}, head ${k.minHeadTestRuns}`],
        ["Required check", k.gateCheck],
        ["Review quorum", `${k.reviewQuorum} independent vendors, never the implementer's`],
        ["Max Scouts per repo", String(k.maxScouts)],
        ["Always protected paths", k.universalProtected.join(", ")],
      ]} />
    </Section>
  );
}

export type SettingsScope = "machine" | "repo" | "accounts" | "kernel";
const SCOPES: Array<{ scope: SettingsScope; label: string; hash: string }> = [
  { scope: "machine", label: "This machine", hash: "#/settings" },
  { scope: "repo", label: "Repo", hash: "#/settings/repo" },
  { scope: "accounts", label: "Accounts (read-only)", hash: "#/settings/accounts" },
  { scope: "kernel", label: "Kernel (read-only)", hash: "#/settings/kernel" },
];

const MACHINE_VIEWS = [{ view: "view", label: "Overview" }, { view: "form", label: "Form" }, { view: "raw", label: "Raw" }] as const;

export function SettingsPage({ scope, settings, onRetry, children }: { scope: SettingsScope; settings: Feed<SettingsState>; onRetry: () => void; children?: React.ReactNode }) {
  const [machineView, setMachineView] = useState<"view" | "form" | "raw">("view");
  return (
    <Box maxW="64rem" mx="auto" p="6">
      <Heading size="xl">Settings</Heading>
      <Flex gap="2" mt="3" as="nav" aria-label="Settings scope">
        {SCOPES.map((x) => (
          <Link key={x.scope} href={x.hash} aria-current={x.scope === scope ? "page" : undefined} px="2" py="1" rounded="md" bg={x.scope === scope ? "bg.muted" : undefined} fontWeight={x.scope === scope ? "semibold" : "normal"} textDecoration="none">
            {x.label}
          </Link>
        ))}
      </Flex>
      {scope === "machine" ? (
        <Flex gap="2" mt="3" as="nav" aria-label="This machine view">
          {MACHINE_VIEWS.map((x) => (
            <Button key={x.view} size="xs" variant={x.view === machineView ? "solid" : "outline"} aria-pressed={x.view === machineView} onClick={() => setMachineView(x.view)}>
              {x.label}
            </Button>
          ))}
        </Flex>
      ) : null}
      {scope === "machine" && machineView !== "view" ? (
        <HostConfigEditor view={machineView} onSaved={onRetry} />
      ) : scope === "repo" ? (
        children
      ) : scope === "accounts" ? (
        <AccountsPanel />
      ) : settings.data === null ? (
        settings.error ? (
          <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" p="3" mt="6">
            <Text fontWeight="medium">Settings unavailable.</Text>
            <Text textStyle="sm">{settings.error}</Text>
            <Button size="sm" mt="2" onClick={onRetry}>Retry</Button>
          </Box>
        ) : (
          <Text color="fg.muted" mt="6">Loading settings...</Text>
        )
      ) : (
        <>
          {settings.error ? (
            <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" px="3" py="2" mt="4" textStyle="sm">
              Refresh failed ({settings.error}); showing the last loaded copy.
            </Box>
          ) : null}
          {scope === "machine" ? (
            <>
              <Machine s={settings.data} />
              <Environment s={settings.data} />
            </>
          ) : (
            <Kernel s={settings.data} />
          )}
        </>
      )}
    </Box>
  );
}
