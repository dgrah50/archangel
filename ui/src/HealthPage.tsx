import { Box, Button, Flex, Skeleton, Stack, Text } from "@chakra-ui/react";
import { useCallback, useEffect } from "react";
import { useState } from "react";
import type { DoctorPayload } from "../../src/core/ui-doctor.js";
import type { DoctorCheck } from "../../src/core/doctor.js";
import type { UiState } from "../../src/core/ui-state.js";
import { age } from "./common";
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

/** A failed read: amber text and the reason, nothing assumed. */
export function ReadError({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <Box role="alert" py="3">
      <Text textStyle="label" color="owner">{title}</Text>
      {children}
    </Box>
  );
}

function CheckRow({ c }: { c: DoctorCheck }) {
  const cmd = c.remediation ? commandIn(c.remediation) : null;
  const ok = c.status === "pass";
  return (
    <Flex gap="4" py="3" align="flex-start">
      <Text textStyle="meta" fontWeight="500" w="52px" flexShrink={0} color={ok ? "passed" : "owner"}>
        {ok ? "Passed" : c.status === "warn" ? "Warning" : "Failing"}
      </Text>
      <Flex direction="column" gap="1" flex="1" minW="0">
        <Text textStyle="rowTitle" color="fg">{c.name}</Text>
        <Text textStyle="meta" color="fg.muted">{c.detail}</Text>
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
    return (
      <Stack gap="2" aria-busy="true">
        <Skeleton height="3rem" />
        <Skeleton height="3rem" />
        <Text textStyle="meta" color="fg.muted">Running...</Text>
      </Stack>
    );
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
export function FaultsSection({ faults, now }: { faults: UiState["faults"] | null; now: number }) {
  return (
    <Section aria-label="Faults" gap="2">
      <Text textStyle="rowTitle" color="fg">Faults</Text>
      <Text textStyle="meta" color="fg.muted">Recorded by the daemon in the last 24 hours, per repo and error class.</Text>
      {faults === null ? (
        <ReadError title="Faults are unavailable.">
          <Text textStyle="meta" color="fg.muted">The Ledger schema is older than this dashboard. Restart the daemon so it can migrate.</Text>
        </ReadError>
      ) : faults.length === 0 ? (
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
