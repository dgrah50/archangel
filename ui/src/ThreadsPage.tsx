import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { useState } from "react";
import type { NeedGroup, UiItem, UiState } from "../../src/core/ui-state.js";
import type { ThreadDetail } from "../../src/core/ui-thread.js";
import type { Feed } from "./AppView";
import { EmptyState } from "./arc/empty-state/empty-state";
import SegmentedControl from "./arc/segmented-control/segmented-control";
import { Group, MasterDetail, Page, PageHeadline, type Tone } from "./page";
import { runningOf, ThreadLine } from "./thread-lines";
import { ThreadDetailPage } from "./ThreadDetailPage";
import type { ItemRef } from "./route";

// Strings from the Ledger are untrusted: rendered only as React text children; links only for well-formed repo slugs.

/** The Threads headline count and the nav badge: Threads in the groups that are open, optionally for one repo. */
const OPEN: NeedGroup[] = ["Needs you", "Stuck", "Ready for owner", "In review", "Waiting on CI", "Working"];
export const openThreadCount = (groups: UiState["groups"], repo = "") => OPEN.reduce((n, g) => n + groups[g].filter((i) => repo === "" || i.repo === repo).length, 0);

/** Threads grouped by need (left), one Thread in full (right). The left pane comes from /api/state.groups and reads like the Overview's list: same groups, names, order and dots. */
export function ThreadsPage({ state, item, thread, now, onRetry }: { state: UiState; item: ItemRef | null; thread: Feed<ThreadDetail>; now: number; onRetry: () => void }) {
  const [repo, setRepo] = useState("");
  const repos = [...new Set(Object.values(state.groups).flatMap((l) => l.map((i) => i.repo)))].sort();
  const pick = (g: NeedGroup) => state.groups[g].filter((i) => repo === "" || i.repo === repo);
  const running = runningOf(state.groups, repo);
  const live = openThreadCount(state.groups, repo);
  const owed = pick("Needs you").length;
  const allEmpty = Object.values(state.groups).every((l) => l.length === 0);
  const stuck = state.groups.Stuck.length;
  // The pane is narrow, so a row carries just the ref after its title; the phase and the decision are in the open Thread.
  const groups: Array<{ label: string; tone: Tone; items: UiItem[]; folded?: boolean }> = [
    { label: "Needs you", tone: "owner", items: pick("Needs you") },
    { label: "Stuck", tone: "owner", items: pick("Stuck") },
    { label: "Ready for you to merge", tone: "ring", items: pick("Ready for owner") },
    { label: "Running", tone: "ink", items: running },
    { label: "Queued", tone: "hollow", items: pick("Queued"), folded: true },
    { label: "Landed in the last 7 days", tone: "passed", items: pick("Done in last 7 days"), folded: true },
  ];
  const none = groups.every((g) => g.items.length === 0);
  return (
    <Page px="0" pb="0">
      <Box px={{ base: "6", md: "56px" }}>
        <PageHeadline
          title="Threads"
          right={repos.length > 1 ? <SegmentedControl label="Filter by repo" value={repo} onValueChange={setRepo} options={["", ...repos].map((r) => ({ value: r, label: r === "" ? "All repos" : r.split("/").pop()! }))} /> : undefined}
        >
          {allEmpty ? "none yet" : [`${live} open`, owed > 0 ? `${owed} need you` : null, stuck > 0 ? `${stuck} stuck` : null].filter(Boolean).join(" · ")}
        </PageHeadline>
      </Box>
      {allEmpty ? (
        <Text color="fg.muted" px={{ base: "6", md: "56px" }}>
          Label an owner-authored issue `ready-for-agent` to start one.
        </Text>
      ) : (
        <MasterDetail
          list={
            <>
              {none ? (
                <Box px="3" pt="1">
                  <Text color="fg.muted">No Threads match.</Text>
                  {repo !== "" ? (
                    <Button size="sm" mt="2" onClick={() => setRepo("")}>
                      Clear
                    </Button>
                  ) : null}
                </Box>
              ) : null}
              <Flex direction="column" gap="1">
                {groups.map((g) => (
                  <Group key={g.label} label={g.label} n={g.items.length} tone={g.tone} folded={g.folded && !g.items.some((i) => item !== null && i.repo === item.repo && i.issueNumber === item.issue)}>
                    {g.items.map((i) => (
                      <ThreadLine key={`${i.repo}#${i.issueNumber}`} i={i} now={now} tone={g.tone} meta="" selected={item} />
                    ))}
                  </Group>
                ))}
              </Flex>
            </>
          }
        >
          {item ? (
            <ThreadDetailPage item={item} thread={thread} now={now} onRetry={onRetry} />
          ) : (
            <Flex align="center" justify="center" h="full" minH="360px">
              <EmptyState title="No Thread selected" description="Pick a Thread on the left to see its phase, timeline and Gate proof." />
            </Flex>
          )}
        </MasterDetail>
      )}
    </Page>
  );
}
