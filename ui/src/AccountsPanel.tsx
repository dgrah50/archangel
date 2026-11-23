import { Button, Flex, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";
import type { AccountRow, AccountsState } from "../../src/core/ui-accounts.js";
import { POLL_MS } from "./AppView";
import { tokenOf } from "./HealthPage";
import { Problem } from "./HostConfigEditor";

const when = (t: number) => new Date(t).toLocaleString();
export const back = (ms: number) => {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${m % 60} m`;
};
const ROLE_WORD: Record<string, string> = { implement: "building", revise: "revising", rebase: "rebasing", review: "reviewing" };

export function Account({ a }: { a: AccountRow }) {
  const cooling = a.cooldownUntil !== null && a.cooldownUntil > Date.now();
  return (
    <Flex gap="4" align="baseline" py="2.5">
      <Text textStyle="command" fontSize="13px" w="120px" flexShrink={0}>{a.id}</Text>
      <Flex direction="column" flex="1" minW="0">
        {cooling ? (
          <Text textStyle="body13" color="owner">Hit its limit. Back in {back(a.cooldownUntil! - Date.now())}.</Text>
        ) : (
          <Text textStyle="body13">{a.roles.length > 0 ? `Ready. Used for ${a.roles.map((r) => ROLE_WORD[r] ?? r).join(", ")}.` : "Ready. Not in any chain."}</Text>
        )}
        <Text textStyle="meta" color="fg.subtle">
          {a.vendor} via {a.provider}, {a.home ?? "CLI default home"}
          {a.lastSwitch ? `. Last switched away ${when(a.lastSwitch.at)}: ${a.lastSwitch.reason}` : ""}
        </Text>
      </Flex>
      <Text textStyle="body13" color="fg.muted" flexShrink={0}>
        {a.maxAttemptsPerDay === null ? `${a.attemptsToday} ${a.attemptsToday === 1 ? "attempt" : "attempts"} today, no cap` : `${a.attemptsToday} of ${a.maxAttemptsPerDay} today`}
      </Text>
    </Flex>
  );
}

/** GET /api/accounts: needs the page's token and is never served remotely. Every failure is a visible state. */
/** This machine's accounts, polled. `token` is null when the dashboard cannot read them (remote mode). */
export function useAccounts() {
  const [data, setData] = useState<AccountsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = tokenOf();
  const load = useCallback(() => {
    if (!token) return;
    fetch("/api/accounts", { headers: { "x-archangel-token": token } })
      .then(async (r) => {
        const body: unknown = await r.json().catch(() => null);
        if (!r.ok) throw new Error(`${r.status}: ${(body as { error?: string } | null)?.error ?? "request failed"}`);
        if (typeof body !== "object" || body === null || typeof (body as { state?: unknown }).state !== "string") throw new Error("unexpected payload");
        setData(body as AccountsState);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [token]);
  useEffect(() => {
    load();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
  }, [load]);
  return { data, error, token, load };
}

export function AccountsPanel() {
  const { data, error, token, load } = useAccounts();

  const retry = (
    <Button size="xs" variant="outline" borderRadius="10px" mt="2" onClick={load}>Retry</Button>
  );
  if (!token) return <Problem title="Accounts are off for this dashboard (remote mode, or no token)."><Text textStyle="meta" color="fg.muted">Start `archangel ui` without --allow-remote to see them.</Text></Problem>;
  if (!data) return error ? <Problem title="Accounts unavailable."><Text textStyle="meta" color="fg.muted">{error}</Text>{retry}</Problem> : <Text textStyle="body13" color="fg.muted">Loading accounts...</Text>;
  if (data.state !== "ok") return <Problem title={data.state === "missing" ? "No archangel.yaml." : data.state === "invalid" ? "archangel.yaml is invalid." : "archangel.yaml could not be read."}><Text textStyle="meta" color="fg.muted">{data.error}</Text></Problem>;
  return (
    <Flex direction="column" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
      {error ? <Problem title="Refresh failed; showing the last loaded copy."><Text textStyle="meta" color="fg.muted">{error}</Text>{retry}</Problem> : null}
      {data.warnings.map((w) => <Text key={w} role="alert" textStyle="body13" py="2.5">{w}</Text>)}
      {data.implicit ? <Text textStyle="body13" color="fg.muted" py="2.5">Using one login per CLI (no accounts configured).</Text> : null}
      {data.accounts.map((a) => <Account key={a.id} a={a} />)}
    </Flex>
  );
}
