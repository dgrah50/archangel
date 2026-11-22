import { Badge, Box, Button, Code, Flex, Heading, Skeleton, Stack, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";
import type { DoctorPayload } from "../../src/core/ui-doctor.js";
import type { DoctorCheck } from "../../src/core/doctor.js";

const TONE: Record<DoctorCheck["status"], string> = { pass: "green", warn: "orange", fail: "red" };

export type Ladder = { state: "idle" } | { state: "running" } | { state: "error"; message: string } | { state: "done"; payload: DoctorPayload };

/** The first `backticked` command in a remediation, if any. */
export const commandIn = (text: string): string | null => /`([^`]+)`/.exec(text)?.[1] ?? null;

function CopyCommand({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="2xs" variant="outline" ml="2" onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true))}>
      {done ? "Copied" : "Copy command"}
    </Button>
  );
}

function CheckRow({ c }: { c: DoctorCheck }) {
  const cmd = c.remediation ? commandIn(c.remediation) : null;
  return (
    <Box as="li" borderLeftWidth="3px" borderLeftColor={`${TONE[c.status]}.solid`} pl="3" py="1">
      <Badge colorPalette={TONE[c.status]} mr="2">{c.status}</Badge>
      <Text as="span" fontWeight="medium">{c.name}</Text>
      <Text color="fg.muted" textStyle="sm">{c.detail}</Text>
      {c.remediation ? (
        <Text textStyle="sm">
          {c.remediation}
          {cmd ? <CopyCommand text={cmd} /> : null}
        </Text>
      ) : null}
    </Box>
  );
}

/** One ladder: loading, error with Recheck, or rows. Presentation only, so every state is renderable in a test. */
export function LadderView({ title, hint, ladder, onRun, runLabel, disabledReason }: { title: string; hint: string; ladder: Ladder; onRun: () => void; runLabel: string; disabledReason?: string }) {
  return (
    <Box as="section" mt="8">
      <Flex align="center" gap="3" wrap="wrap">
        <Heading size="md">{title}</Heading>
        <Button size="xs" onClick={onRun} disabled={ladder.state === "running" || Boolean(disabledReason)}>
          {runLabel}
        </Button>
      </Flex>
      <Text color="fg.muted" textStyle="sm">{disabledReason ?? hint}</Text>
      <Box mt="3">
        {ladder.state === "idle" ? <Text color="fg.muted">Not run yet.</Text> : null}
        {ladder.state === "running" ? (
          <Stack gap="2" aria-busy="true">
            <Skeleton height="3rem" />
            <Skeleton height="3rem" />
            <Text color="fg.muted" textStyle="sm">Running...</Text>
          </Stack>
        ) : null}
        {ladder.state === "error" ? (
          <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" p="3">
            <Text fontWeight="medium">The check could not run.</Text>
            <Text textStyle="sm">{ladder.message}</Text>
          </Box>
        ) : null}
        {ladder.state === "done" ? (
          ladder.payload.checks.length === 0 ? (
            <Text color="fg.muted">No checks reported.</Text>
          ) : (
            <Stack as="ul" listStyleType="none" gap="2" aria-label={title}>
              {ladder.payload.checks.map((c) => (
                <CheckRow key={c.id} c={c} />
              ))}
            </Stack>
          )
        ) : null}
      </Box>
    </Box>
  );
}

const tokenOf = () => typeof document === "undefined" ? null : document.querySelector('meta[name="archangel-token"]')?.getAttribute("content") ?? null;

function useLadder(scope: "machine" | "repo", smoke: boolean, auto: boolean): [Ladder, () => void] {
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

/** Smoke and repo checks run only on a button press, never on a poll. */
export function HealthPage() {
  const hasToken = tokenOf() !== null;
  const [machine, runMachine] = useLadder("machine", false, true);
  const [smoke, runSmoke] = useLadder("machine", true, false);
  const [repo, runRepo] = useLadder("repo", false, false);
  const noToken = hasToken ? undefined : "Needs the local dashboard: start `archangel ui` without --allow-remote.";
  return (
    <Box maxW="64rem" mx="auto" p="6">
      <Heading size="xl">Health</Heading>
      <Text color="fg.muted" textStyle="sm">
        Read-only checks of this machine and its GitHub wiring. Nothing here changes anything; fix issues with the commands shown. These checks run in the dashboard process, so environment-variable checks reflect this shell, not the daemon: what the daemon actually has comes from the facts it records at start (Settings, Environment).
      </Text>
      <LadderView title="This machine" hint="Git, configuration, App key, CLIs, SQLite, Paseo, gh login. No network." ladder={machine} onRun={runMachine} runLabel="Recheck" />
      <LadderView title="Subscription CLIs (smoke)" hint="Runs each CLI's version and login-status command. Never calls a model." ladder={smoke} onRun={runSmoke} runLabel="Run smoke checks" disabledReason={noToken} />
      <LadderView title="GitHub wiring" hint="App permissions, Gate workflow and pin, labels. Calls the GitHub API." ladder={repo} onRun={runRepo} runLabel="Run GitHub checks" disabledReason={noToken} />
    </Box>
  );
}
