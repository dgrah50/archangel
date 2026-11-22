import { Badge, Box, Flex, Heading, Link, Text } from "@chakra-ui/react";
import type { HostStatus } from "../../src/core/host-facts.js";
import type { UiState } from "../../src/core/ui-state.js";
import type { Feed } from "./AppView";
import { NAV, itemHash, type Route } from "./route";

/** Left nav on wide screens, a top bar on narrow ones, plus a persistent header strip (daemon status, Needs You count). */
export function Shell({ route, state, host, children }: { route: Route; state: UiState | null; host: Feed<HostStatus>; children: React.ReactNode }) {
  const needs = state?.needsYou.length ?? null;
  return (
    <Flex direction={{ base: "column", md: "row" }} minH="100vh">
      <Box as="nav" aria-label="Pages" borderColor="border" borderBottomWidth={{ base: "1px", md: "0" }} borderEndWidth={{ md: "1px" }} w={{ md: "13rem" }} flexShrink={0} p="4">
        <Heading size="md" mb={{ base: "2", md: "4" }}>
          Archangel
        </Heading>
        <Flex direction={{ base: "row", md: "column" }} gap="1" wrap="wrap">
          {NAV.map((n) => (
            <Link key={n.page} href={n.hash} aria-current={route.page === n.page ? "page" : undefined} px="2" py="1" rounded="md" fontWeight={route.page === n.page ? "semibold" : "normal"} bg={route.page === n.page ? "bg.muted" : undefined} textDecoration="none">
              {n.label}
            </Link>
          ))}
        </Flex>
      </Box>
      <Box flex="1" minW="0">
        <Flex as="header" aria-label="Status" gap="3" align="center" px="6" py="2" borderBottomWidth="1px" borderColor="border" textStyle="sm">
          <Daemon state={state} />
          {host.data?.restartPending ? (
            <Badge colorPalette="orange" title="archangel.yaml on disk differs from what the daemon loaded. Host settings apply after a restart.">
              Host config changed: restart pending
            </Badge>
          ) : host.data === null && host.error ? (
            <Badge colorPalette="red" title={host.error}>host status unavailable</Badge>
          ) : null}
          {needs === null ? null : needs === 0 ? (
            <Text color="fg.muted">Nothing needs you</Text>
          ) : (
            <>
              <Badge colorPalette="orange">{needs} need you</Badge>
              <Link href={nextHash(state, route)}>Next</Link>
            </>
          )}
        </Flex>
        {children}
      </Box>
    </Flex>
  );
}

function Daemon({ state }: { state: UiState | null }) {
  if (state === null) return <Badge>daemon unknown</Badge>;
  const beat = state.daemonHeartbeatAt;
  const live = beat !== null && state.generatedAt - beat <= 3 * 60_000;
  return <Badge colorPalette={live ? "green" : "red"}>{live ? "daemon running" : "daemon offline"}</Badge>;
}

/** "Next" opens the item after the one on screen, or the oldest when none is open. */
function nextHash(state: UiState | null, route: Route): string {
  const q = state?.needsYou ?? [];
  if (q.length === 0) return "#/needs-you";
  const at = route.page === "needs-you" && route.item ? q.findIndex((i) => i.repo === route.item!.repo && i.issueNumber === route.item!.issue) : -1;
  const n = q[(at + 1) % q.length]!;
  return itemHash({ repo: n.repo, issue: n.issueNumber });
}
