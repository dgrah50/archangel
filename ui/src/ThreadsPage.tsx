import { Badge, Box, Button, Heading, NativeSelect, Text, chakra } from "@chakra-ui/react";
import { useState } from "react";
import type { UiState } from "../../src/core/ui-state.js";
import { ThreadTable } from "./common";
import { NEED_GROUPS_UI } from "./payload";

const Details = chakra("details");
const SHOW_RECENT = 5;
const STORE = "archangel.threads.collapsed";

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(window.localStorage.getItem(STORE) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Threads grouped by what they need. Quiet groups start folded; the browser remembers what the owner toggled. */
export function ThreadsPage({ state }: { state: UiState }) {
  const [repo, setRepo] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => (typeof window === "undefined" ? {} : readCollapsed()));
  const repos = [...new Set(Object.values(state.groups).flatMap((l) => l.map((i) => i.repo)))].sort();
  const groups = NEED_GROUPS_UI.map((g) => ({ g, items: state.groups[g].filter((i) => repo === "" || i.repo === repo) }));
  const total = groups.reduce((t, x) => t + x.items.length, 0);
  const allEmpty = Object.values(state.groups).every((l) => l.length === 0);
  const toggle = (g: string, open: boolean) => {
    const next = { ...collapsed, [g]: !open };
    setCollapsed(next);
    try {
      window.localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      // storage unavailable: the choice just is not remembered
    }
  };
  return (
    <Box maxW="64rem" mx="auto" p="6">
      <Heading size="xl">Threads</Heading>
      {allEmpty ? (
        <Text color="fg.muted" mt="4">
          No Threads yet. Label an owner-authored issue `ready-for-agent` to start one.
        </Text>
      ) : (
        <>
          <Box mt="3" maxW="16rem">
            <NativeSelect.Root size="sm">
              <NativeSelect.Field aria-label="Filter by repo" value={repo} onChange={(e) => setRepo(e.currentTarget.value)}>
                <option value="">All repos</option>
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </NativeSelect.Field>
            </NativeSelect.Root>
          </Box>
          {total === 0 ? (
            <Box mt="4">
              <Text color="fg.muted">No Threads match.</Text>
              <Button size="sm" mt="2" onClick={() => setRepo("")}>
                Clear
              </Button>
            </Box>
          ) : null}
          {groups
            .filter((x) => x.items.length > 0)
            .map(({ g, items }) => {
              const quiet = g === "Queued" || g === "Done in last 7 days";
              const open = !(collapsed[g] ?? quiet);
              const older = items.slice(SHOW_RECENT);
              return (
                <Details key={g} open={open} onToggle={(e: React.SyntheticEvent<HTMLElement>) => {
                    const now = (e.currentTarget as HTMLDetailsElement).open;
                    if (now !== open) toggle(g, now);
                  }} mt="5" borderWidth="1px" rounded="xl" px="4" py="2">
                  <Box as="summary" cursor="pointer" fontWeight="medium" py="1">
                    {g}{" "}
                    <Badge variant="subtle" ml="1" colorPalette={g === "Needs you" || g === "Stuck" ? "orange" : undefined}>
                      {items.length}
                    </Badge>
                  </Box>
                  <ThreadTable items={items.slice(0, SHOW_RECENT)} now={state.generatedAt} />
                  {older.length > 0 ? (
                    <Box as="details" mt="1">
                      <Box as="summary" cursor="pointer" color="fg.muted" textStyle="sm">
                        Show {older.length} older
                      </Box>
                      <ThreadTable items={older} now={state.generatedAt} />
                    </Box>
                  ) : null}
                </Details>
              );
            })}
        </>
      )}
    </Box>
  );
}
