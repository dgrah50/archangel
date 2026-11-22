import { Box, Button, Flex, Link, Text } from "@chakra-ui/react";
import { useState } from "react";
import type { NeedGroup, UiItem, UiState } from "../../src/core/ui-state.js";
import type { ThreadDetail } from "../../src/core/ui-thread.js";
import type { Feed } from "./AppView";
import { age } from "./common";
import { Owed, Page, PageHeadline, Ref } from "./page";
import { ThreadDetailPage } from "./ThreadDetailPage";
import { threadHash, type ItemRef } from "./route";

// Strings from the Ledger are untrusted: rendered only as React text children; links only for well-formed repo slugs.

/** Shown open, in this order. `Stuck` is only listed when something is stuck. */
const OPEN: NeedGroup[] = ["Needs you", "Stuck", "Ready for owner", "In review", "Waiting on CI", "Working"];
const FOLDED: NeedGroup[] = ["Queued", "Done in last 7 days"];
const SLUG = /^[\w.-]+\/[\w.-]+$/;

const gap = (ms: number) => age(ms).replace(/(\d)([a-z])/, "$1 $2");
const same = (i: UiItem, s: ItemRef | null) => s !== null && i.repo === s.repo && i.issueNumber === s.issue;

function ThreadRow({ i, now, selected }: { i: UiItem; now: number; selected: boolean }) {
  const body = (
    <Flex align="center" gap="3" px="3" h="38px" rounded="10px" bg={selected ? "bg.muted" : undefined} borderWidth="1px" borderColor={selected ? "border" : "transparent"} _hover={{ bg: "bg.muted" }}>
      <Text color="fg.muted" w="112px" flexShrink={0} truncate>
        <Ref repo={i.repo} num={i.issueNumber} />
      </Text>
      <Text textStyle="body13" color="fg" flex="1" minW="0" truncate>
        {i.title}
      </Text>
      <Text textStyle="meta" color="fg.subtle" flexShrink={0}>
        {gap(now - i.since)}
      </Text>
    </Flex>
  );
  return SLUG.test(i.repo) ? (
    <Link display="block" href={threadHash({ repo: i.repo, issue: i.issueNumber })} color="inherit" textDecoration="none" _hover={{ textDecoration: "none" }} aria-current={selected ? "true" : undefined}>
      {body}
    </Link>
  ) : (
    body
  );
}

function GroupBlock({ g, items, now, item }: { g: NeedGroup; items: UiItem[]; now: number; item: ItemRef | null }) {
  return (
    <Box>
      <Flex justify="space-between" px="3" pt="3.5" pb="1.5" textStyle="label" color={g === "Needs you" ? "owner" : "fg"}>
        <Text>{g}</Text>
        <Text textStyle="meta" color="inherit">
          {items.length}
        </Text>
      </Flex>
      {items.map((i) => (
        <ThreadRow key={`${i.repo}#${i.issueNumber}`} i={i} now={now} selected={same(i, item)} />
      ))}
    </Box>
  );
}

/** Threads grouped by what they need (left), one Thread in full (right). The left pane comes from /api/state.groups. */
export function ThreadsPage({ state, item, thread, now, onRetry }: { state: UiState; item: ItemRef | null; thread: Feed<ThreadDetail>; now: number; onRetry: () => void }) {
  const [repo, setRepo] = useState("");
  const repos = [...new Set(Object.values(state.groups).flatMap((l) => l.map((i) => i.repo)))].sort();
  const pick = (g: NeedGroup) => state.groups[g].filter((i) => repo === "" || i.repo === repo);
  const open = OPEN.map((g) => ({ g, items: pick(g) })).filter((x) => x.items.length > 0);
  const folded = FOLDED.map((g) => ({ g, items: pick(g) })).filter((x) => x.items.length > 0);
  const live = open.reduce((n, x) => n + x.items.length, 0);
  const owed = pick("Needs you").length;
  const allEmpty = Object.values(state.groups).every((l) => l.length === 0);
  const stuck = state.groups.Stuck.length;
  return (
    <Page px="0" pb="0">
      <Flex px={{ base: "6", md: "56px" }} justify="space-between" align="flex-end" gap="4" wrap="wrap">
        <PageHeadline sub={`${owed > 0 ? "Yours first, then everything that is moving without you. " : "Everything here is moving without you. "}${stuck === 0 ? "Nothing is stuck." : `${stuck} stuck.`}`}>
          {allEmpty ? "No Threads yet." : owed > 0 ? <>{live} Threads, <Owed>{owed} need you</Owed>.</> : `${live} Threads, sorted by what each one needs.`}
        </PageHeadline>
        {repos.length > 1 ? (
          <Flex gap="1" bg="bg.muted" rounded="14px" p="1" mb="6" role="group" aria-label="Filter by repo">
            {["", ...repos].map((r) => (
              <Button key={r} size="sm" variant="plain" h="30px" px="3" rounded="10px" fontWeight={repo === r ? "500" : "400"} color={repo === r ? "fg" : "fg.muted"} bg={repo === r ? "bg" : "transparent"} aria-pressed={repo === r} onClick={() => setRepo(r)}>
                {r === "" ? "All repos" : r.split("/").pop()}
              </Button>
            ))}
          </Flex>
        ) : null}
      </Flex>
      {allEmpty ? (
        <Text color="fg.muted" px={{ base: "6", md: "56px" }}>
          Label an owner-authored issue `ready-for-agent` to start one.
        </Text>
      ) : (
        <Flex borderTopWidth="1px" borderTopColor="border" flex="1" minH="0" direction={{ base: "column", lg: "row" }}>
          <Flex direction="column" w={{ lg: "356px" }} flexShrink={0} borderEndWidth={{ lg: "1px" }} borderColor="border" px="3" pb="3">
            <Box flex="1">
              {open.length === 0 ? (
                <Box px="3" pt="4">
                  <Text color="fg.muted">No Threads match.</Text>
                  {repo !== "" ? (
                    <Button size="sm" mt="2" onClick={() => setRepo("")}>
                      Clear
                    </Button>
                  ) : null}
                </Box>
              ) : null}
              {open.map(({ g, items }) => (
                <GroupBlock key={g} g={g} items={items} now={now} item={item} />
              ))}
            </Box>
            {folded.map(({ g, items }) => (
              <Box as="details" key={g} borderTopWidth="1px" borderTopColor="border" mt="2" pt="2">
                <Text as="summary" textStyle="body13" color="fg.muted" cursor="pointer" px="3" py="1">
                  {g} {items.length}
                </Text>
                {items.map((i) => (
                  <ThreadRow key={`${i.repo}#${i.issueNumber}`} i={i} now={now} selected={same(i, item)} />
                ))}
              </Box>
            ))}
          </Flex>
          <Box flex="1" minW="0">
            {item ? (
              <ThreadDetailPage item={item} thread={thread} now={now} onRetry={onRetry} />
            ) : (
              <Text color="fg.muted" p="6">
                Pick a Thread to see its phase, timeline and Gate proof.
              </Text>
            )}
          </Box>
        </Flex>
      )}
    </Page>
  );
}
