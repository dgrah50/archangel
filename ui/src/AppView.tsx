import { Box, Button, Text } from "@chakra-ui/react";
import type { UiState, WorkflowsState } from "../../src/core/ui-state.js";
import { Dashboard } from "./Dashboard";
import { Pipeline } from "./Pipeline";

/** One polled feed: the last good data, when it arrived (client clock), and the last failure if the latest poll failed. */
export interface Feed<T> {
  data: T | null;
  at: number | null;
  error: string | null;
}

export const POLL_MS = 15_000;
/** Data older than two poll intervals means polling has stopped working even if nothing reported an error. */
export const STALE_MS = 2 * POLL_MS;
/** The daemon renews its lock every 30s; the host default lease is 3 minutes. */
export const DAEMON_OFFLINE_MS = 3 * 60_000;

const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

function Notice({ tone, children }: { tone: "red" | "orange"; children: React.ReactNode }) {
  return (
    <Box role="alert" borderWidth="1px" borderColor={`${tone}.solid`} rounded="md" px="4" py="2" mb="3" maxW="64rem" mx="auto">
      {children}
    </Box>
  );
}

/** Which banners the current data needs: failed poll, stale data, daemon offline. Pure so each state can be tested. */
export function bannersFor(state: Feed<UiState>, now: number): Array<{ tone: "red" | "orange"; text: string }> {
  const out: Array<{ tone: "red" | "orange"; text: string }> = [];
  if (state.data === null) return out;
  if (state.error) {
    out.push({ tone: "red", text: `Refresh failed (${state.error}). Showing data from ${ago(now - (state.at ?? now))} ago; it may be out of date.` });
  } else if (state.at !== null && now - state.at > STALE_MS) {
    out.push({ tone: "orange", text: `Data is stale: last updated ${ago(now - state.at)} ago.` });
  }
  const beat = state.data.daemonHeartbeatAt;
  if (beat === null) out.push({ tone: "red", text: "Daemon offline: no daemon lock is held. Nothing is being processed. Run `archangel start`." });
  else if (state.data.generatedAt - beat > DAEMON_OFFLINE_MS) out.push({ tone: "red", text: `Daemon offline? Last heartbeat ${ago(state.data.generatedAt - beat)} ago. Nothing is being processed.` });
  return out;
}

export function AppView({ state, workflows, now, onRetry }: { state: Feed<UiState>; workflows: Feed<WorkflowsState>; now: number; onRetry: () => void }) {
  if (state.data === null) {
    if (state.error === null) return <Text p="6" color="fg.muted">Loading...</Text>;
    return (
      <Box maxW="40rem" mx="auto" mt="10" p="5">
        <Notice tone="red">
          <Text fontWeight="medium">Cannot load the dashboard.</Text>
          <Text textStyle="sm">{state.error}</Text>
          <Button size="sm" mt="2" onClick={onRetry}>
            Retry
          </Button>
        </Notice>
      </Box>
    );
  }
  return (
    <>
      <Box pt="4" px="6">
        {bannersFor(state, now).map((b) => (
          <Notice key={b.text} tone={b.tone}>
            <Text textStyle="sm">{b.text}</Text>
          </Notice>
        ))}
      </Box>
      <Dashboard state={state.data} />
      <Box maxW="64rem" mx="auto" px="6" pb="6">
        {workflows.data ? (
          <>
            {workflows.error ? (
              <Notice tone="red">
                <Text textStyle="sm">Pipeline refresh failed ({workflows.error}); showing the last loaded copy.</Text>
              </Notice>
            ) : null}
            <Pipeline data={workflows.data} />
          </>
        ) : workflows.error ? (
          <Notice tone="red">
            <Text fontWeight="medium">Pipeline unavailable.</Text>
            <Text textStyle="sm">{workflows.error}</Text>
            <Button size="sm" mt="2" onClick={onRetry}>
              Retry
            </Button>
          </Notice>
        ) : (
          <Text color="fg.muted">Loading pipeline...</Text>
        )}
      </Box>
    </>
  );
}
