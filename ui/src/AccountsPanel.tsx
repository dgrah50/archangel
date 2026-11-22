import { Badge, Box, Button, Code, Table, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";
import type { AccountsState } from "../../src/core/ui-accounts.js";
import { POLL_MS } from "./AppView";
import { tokenOf } from "./HealthPage";

const when = (t: number) => new Date(t).toLocaleString();

function Alert({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <Box role="alert" borderWidth="1px" borderColor="red.solid" rounded="md" p="3" mt="6">
      <Text fontWeight="medium">{title}</Text>
      {detail ? <Text textStyle="sm">{detail}</Text> : null}
      {onRetry ? <Button size="sm" mt="2" onClick={onRetry}>Retry</Button> : null}
    </Box>
  );
}

/** GET /api/accounts: needs the page's token and is never served remotely. Every failure is a visible state. */
export function AccountsPanel() {
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

  if (!token) return <Alert title="Accounts are off for this dashboard (remote mode, or no token)." detail="Start `archangel ui` without --allow-remote to see them." />;
  if (!data) return error ? <Alert title="Accounts unavailable." detail={error} onRetry={load} /> : <Text color="fg.muted" mt="6">Loading accounts...</Text>;
  if (data.state !== "ok") return <Alert title={data.state === "missing" ? "No archangel.yaml." : data.state === "invalid" ? "archangel.yaml is invalid." : "archangel.yaml could not be read."} detail={data.error} />;
  return (
    <Box mt="6">
      {error ? <Alert title="Refresh failed; showing the last loaded copy." detail={error} onRetry={load} /> : null}
      {data.warnings.map((w) => (
        <Box key={w} role="alert" borderWidth="1px" borderColor="orange.solid" rounded="md" px="3" py="2" mb="3" textStyle="sm">{w}</Box>
      ))}
      {data.implicit ? <Text color="fg.muted" textStyle="sm" mb="3">Using one login per CLI (no accounts configured).</Text> : null}
      <Table.Root size="sm">
        <Table.Header>
          <Table.Row>
            {["Account", "Vendor", "Home", "Cooldown", "Attempts today", "Last switch", "Roles"].map((h) => (
              <Table.ColumnHeader key={h}>{h}</Table.ColumnHeader>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {data.accounts.map((a) => (
            <Table.Row key={a.id}>
              <Table.Cell><Code>{a.id}</Code><Text color="fg.muted" textStyle="xs">{a.provider}</Text></Table.Cell>
              <Table.Cell>{a.vendor}</Table.Cell>
              <Table.Cell>{a.home ? <Code>{a.home}</Code> : <Text color="fg.muted">CLI default</Text>}</Table.Cell>
              <Table.Cell>
                {a.cooldownUntil === null ? <Badge colorPalette="green">ready</Badge> : <Badge colorPalette="orange">cooling until {when(a.cooldownUntil)}</Badge>}
              </Table.Cell>
              <Table.Cell>{a.attemptsToday}{a.maxAttemptsPerDay === null ? " (no cap)" : ` / ${a.maxAttemptsPerDay}`}</Table.Cell>
              <Table.Cell>
                {a.lastSwitch ? (
                  <>
                    <Text>{when(a.lastSwitch.at)}</Text>
                    <Text color="fg.muted" textStyle="xs">{a.lastSwitch.reason}</Text>
                  </>
                ) : (
                  <Text color="fg.muted">none recorded</Text>
                )}
              </Table.Cell>
              <Table.Cell>{a.roles.length > 0 ? a.roles.join(", ") : <Text color="fg.muted">no chain</Text>}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
