import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { useCallback, useEffect } from "react";
import { useState } from "react";
import type { DoctorPayload } from "../../src/core/ui-doctor.js";
import type { DoctorCheck } from "../../src/core/doctor.js";
import type { UiState } from "../../src/core/ui-state.js";
import { age } from "./common";
import { Alert } from "./arc/alert/alert";
import { Badge } from "./arc/badge/badge";
import { Skeleton } from "./arc/skeleton/skeleton";
import { CopyCommand, Row, RowList, Section } from "./page";

export type Ladder = { state: "idle" } | { state: "running" } | { state: "error"; message: string } | { state: "done"; payload: DoctorPayload };

/** The first `backticked` command in a remediation, if any. */
export const commandIn = (text: string): string | null => /`([^`]+)`/.exec(text)?.[1] ?? null;

export const tokenOf = () => (typeof document === "undefined" ? null : document.querySelector('meta[name="archangel-token"]')?.getAttribute("content") ?? null);

export function useLadder(scope: "machine" | "repo", smoke: boolean, auto: boolean): [Ladder, () => void] {
  const [ladder, setLadder] = useState<Ladder>({ state: "idle" });
  const run = useCallback(() => {
    setLadder({ state: "running" });
    const token = tokenOf();
    fetch(`/api/doctor?scope=${scope}${smoke ? "&smoke=1" : ""}`, { headers: token ? { "x-archangel-token": token } : {} })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as DoctorPayload | { error?: string } | null;
        if (!res.ok || body === null || !("checks" in body)) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
        setLadder({ state: "done", payload: body });
      })
      .catch((e: unknown) => setLadder({ state: "error", message: e instanceof Error ? e.message : String(e) }));
  }, [scope, smoke]);
  useEffect(() => {
    if (auto) run();
  }, [auto, run]);
  return [ladder, run];
}

/** A failed read: an alert with the reason, nothing assumed. */
export function ReadError({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <Box mb="3">
      <Alert tone="warning" title={title}>
        {children}
      </Alert>
    </Box>
  );
}

/** A check's result as a badge: green passed, amber failing (the owner has to act), grey warning (works, but look). */
function StatusBadge({ status }: { status: DoctorCheck["status"] }) {
  return (
    <Badge dot size="sm" tone={status === "pass" ? "success" : status === "warn" ? "neutral" : "warning"}>
      {status === "pass" ? "Passed" : status === "warn" ? "Warning" : "Failing"}
    </Badge>
  );
}

function CheckRow({ c }: { c: DoctorCheck }) {
  const cmd = c.remediation ? commandIn(c.remediation) : null;
  return (
    <Flex gap="4" py="3" align="flex-start">
      <Box w="84px" flexShrink={0}>
        <StatusBadge status={c.status} />
      </Box>
      <Flex direction="column" gap="1" flex="1" minW="0">
        <Text textStyle="rowTitle" color="fg">{c.name}</Text>
        <Text textStyle="meta" color="fg.muted" whiteSpace="pre-line">{c.detail}</Text>
        {c.remediation ? <Text textStyle="meta" color="fg.muted">{c.remediation}</Text> : null}
        {cmd ? <CopyCommand command={cmd} /> : null}
      </Flex>
    </Flex>
  );
}

/** One ladder as hairline rows: not run, running, error with its reason, or the checks. */
export function LadderList({ ladder, label }: { ladder: Ladder; label: string }) {
  if (ladder.state === "idle") return <Text textStyle="meta" color="fg.muted">Not run yet.</Text>;
  if (ladder.state === "running") {
    return <Skeleton label={`Running ${label.toLowerCase()} checks`} lines={3} />;
  }
  if (ladder.state === "error") {
    return (
      <ReadError title="The check could not run.">
        <Text textStyle="meta" color="fg.muted">{ladder.message}</Text>
      </ReadError>
    );
  }
  if (ladder.payload.checks.length === 0) return <Text textStyle="meta" color="fg.muted">No checks reported.</Text>;
  return (
    <RowList aria-label={label}>
      {ladder.payload.checks.map((c) => (
        <CheckRow key={c.id} c={c} />
      ))}
    </RowList>
  );
}

/** Smoke checks run only on a button press, never on a poll. */
export function SmokeChecks() {
  const hasToken = tokenOf() !== null;
  const [smoke, runSmoke] = useLadder("machine", true, false);
  return (
    <Flex direction="column" gap="3" mt="6">
      <Flex align="center" gap="3" wrap="wrap">
        <Text textStyle="label" color="fg">Subscription logins</Text>
        <Button size="xs" variant="outline" borderRadius="10px" onClick={runSmoke} disabled={smoke.state === "running" || !hasToken}>
          Run login checks
        </Button>
      </Flex>
      <Text textStyle="meta" color="fg.muted">
        {hasToken ? "Runs each CLI's version and login-status command, only when you press the button. Never calls a model." : "Needs the local dashboard: start `archangel ui` without --allow-remote."}
      </Text>
      {smoke.state === "idle" ? null : <LadderList ladder={smoke} label="Subscription logins" />}
    </Flex>
  );
}

/** Errors the daemon recorded in the last 24h, per repo and class. The error text is untrusted: rendered as text only. */
export function FaultsSection({ faults, now }: { faults: UiState["faults"]; now: number }) {
  return (
    <Section aria-label="Faults" gap="2">
      <Text textStyle="rowTitle" color="fg">Faults</Text>
      <Text textStyle="meta" color="fg.muted">Recorded by the daemon in the last 24 hours, per repo and error class.</Text>
      {faults.length === 0 ? (
        <Text textStyle="meta" color="fg.muted">No errors survived in the last 24h.</Text>
      ) : (
        <RowList>
          {faults.map((f) => (
            <Row
              key={`${f.repo}/${f.category}`}
              lead={`${f.recent24h}`}
              owed
              title={`${f.repo} · ${f.category}`}
              meta={<span title={f.lastError}>{f.count} in total, first {age(now - f.firstSeen)} ago, last {age(now - f.lastSeen)} ago: {f.lastError}</span>}
            />
          ))}
        </RowList>
      )}
    </Section>
  );
}

/** What the telemetry Scout found abnormal in the last 24h. Normal numbers are not shown. */
export function TelemetrySection({ telemetry, now }: { telemetry: UiState["telemetry"]; now: number }) {
  return (
    <Section aria-label="Telemetry" gap="2">
      <Text textStyle="rowTitle" color="fg">Telemetry, last 24 h</Text>
      <Text textStyle="meta" color="fg.muted">Local measurements compared with the week before; only what is abnormal is listed. It clears itself once the numbers return to normal.</Text>
      {telemetry.length === 0 ? (
        <Text textStyle="meta" color="fg.muted">Nothing abnormal in the last 24h (needs signals enabled in archangel.yaml).</Text>
      ) : (
        <RowList>
          {telemetry.map((t) => (
            <Row key={`${t.repo}/${t.title}`} lead="" title={`${t.repo} · ${t.title}`} meta={`${t.detail} Found ${age(now - t.observedAt)} ago.`} />
          ))}
        </RowList>
      )}
    </Section>
  );
}
