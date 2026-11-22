import { Box, Flex, Link, Text } from "@chakra-ui/react";
import type { UiState } from "../../src/core/ui-state.js";
import { Dot, OwedCount } from "./page";
import { openThreadCount } from "./ThreadsPage";
import { NAV, navPageOf, type NavPage, type Route } from "./route";

/** Left nav on wide screens, a top bar on narrow ones. No header strip: each page states its own situation in its headline. */
export function Shell({ route, state, children }: { route: Route; state: UiState | null; children: React.ReactNode }) {
  const here = navPageOf(route);
  const counts = navCounts(state);
  return (
    <Flex direction={{ base: "column", md: "row" }} minH="100vh">
      <Flex as="aside" direction="column" gap="18px" bg="bg.subtle" borderColor="border" borderBottomWidth={{ base: "1px", md: "0" }} borderEndWidth={{ md: "1px" }} w={{ md: "232px" }} flexShrink={0} px="12px" py="14px" position={{ md: "sticky" }} top="0" h={{ md: "100vh" }}>
        <Flex align="center" gap="10px" px="6px" py="4px">
          <Flex align="center" justify="center" w="26px" h="26px" rounded="8px" bg="fg" color="bg" flexShrink={0}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M7 1.5 12 12H9.6L7 6.2 4.4 12H2L7 1.5Z" fill="currentColor" />
            </svg>
          </Flex>
          <Box flex="1" minW="0">
            <Text textStyle="figure" fontSize="15px" color="fg">
              Archangel
            </Text>
            <Text textStyle="caption" color="fg.subtle" truncate>
              {window.location.host}
            </Text>
          </Box>
        </Flex>
        <Flex as="nav" aria-label="Pages" direction={{ base: "row", md: "column" }} wrap="wrap" gap="2px">
          {NAV.map((n) => (
            <NavItem key={n.page} page={n.page} label={n.label} hash={n.hash} active={here === n.page} count={counts[n.page]} />
          ))}
        </Flex>
        <Repos state={state} />
        <Box flex="1" display={{ base: "none", md: "block" }} />
        <DaemonLine state={state} />
      </Flex>
      <Flex direction="column" flex="1" minW="0" minH={{ md: "100vh" }}>
        {children}
      </Flex>
    </Flex>
  );
}

function navCounts(state: UiState | null): Partial<Record<NavPage, { n: number; owed: boolean }>> {
  if (!state) return {};
  const live = openThreadCount(state.groups);
  return {
    "needs-you": state.needsYou.length > 0 ? { n: state.needsYou.length, owed: true } : undefined,
    threads: live > 0 ? { n: live, owed: false } : undefined,
    pitches: state.pitches.count > 0 ? { n: state.pitches.count, owed: true } : undefined,
  };
}

const ICONS: Record<NavPage, React.ReactNode> = {
  overview: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1.2" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" />
    </>
  ),
  "needs-you": (
    <>
      <path d="M2.5 9.5h3l1 2h3l1-2h3" />
      <path d="M2.5 9.5 4 3.5h8l1.5 6v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-3Z" />
    </>
  ),
  threads: (
    <>
      <circle cx="4" cy="3.5" r="1.5" />
      <circle cx="4" cy="12.5" r="1.5" />
      <circle cx="12" cy="6" r="1.5" />
      <path d="M4 5v6M12 7.5c0 2.5-8 1-8 3.5" />
    </>
  ),
  pipeline: (
    <>
      <rect x="1.5" y="5.5" width="3.5" height="5" rx="1" />
      <rect x="6.25" y="5.5" width="3.5" height="5" rx="1" />
      <rect x="11" y="5.5" width="3.5" height="5" rx="1" />
      <path d="M5 8h1.25M9.75 8H11" />
    </>
  ),
  pitches: <path d="M8 1.8a4.2 4.2 0 0 0-2.4 7.6V11h4.8V9.4A4.2 4.2 0 0 0 8 1.8ZM6.3 13.5h3.4" />,
  settings: (
    <>
      <path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" />
      <circle cx="10.5" cy="4.5" r="1.5" />
      <circle cx="5.5" cy="11.5" r="1.5" />
    </>
  ),
  setup: <path d="M1.5 8h3l1.5-4 3 8 1.5-4h4" />,
};

function NavItem({ page, label, hash, active, count }: { page: NavPage; label: string; hash: string; active: boolean; count?: { n: number; owed: boolean } }) {
  return (
    <Link href={hash} aria-current={active ? "page" : undefined} display="flex" alignItems="center" gap="10px" h="34px" px="10px" rounded="10px" borderWidth="1px" borderColor={active ? "border" : "transparent"} bg={active ? "bg" : "transparent"} color={active ? "fg" : "fg.muted"} textStyle="body13" fontWeight={active ? "500" : "400"} lineHeight="16px" textDecoration="none" _hover={{ textDecoration: "none", color: "fg" }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" style={{ flexShrink: 0 }}>
        {ICONS[page]}
      </svg>
      <Box flex="1">{label}</Box>
      {count ? count.owed ? <OwedCount>{count.n}</OwedCount> : <Text textStyle="caption" fontFamily="mono" color="fg.subtle">{count.n}</Text> : null}
    </Link>
  );
}

/** Repos with Threads (or an autonomy cap), each with what the factory or the owner is doing there. */
function Repos({ state }: { state: UiState | null }) {
  if (!state) return null;
  const repos = [...new Set([...Object.keys(state.autonomySteps), ...Object.keys(state.autonomyCaps), ...state.stages.Working.map((i) => i.repo), ...state.needsYou.map((i) => i.repo)])].sort();
  return (
    <Flex direction="column" gap="2px" display={{ base: "none", md: "flex" }}>
      <Text textStyle="caption" fontWeight="500" color="fg.subtle" px="10px" pb="6px">
        Repos
      </Text>
      {repos.map((repo) => {
        const need = state.needsYou.filter((i) => i.repo === repo).length;
        const working = state.stages.Working.filter((i) => i.repo === repo).length;
        return (
          <Flex key={repo} align="center" gap="10px" h="30px" px="10px">
            <Flex w="16px" justify="center" flexShrink={0}>
              <Dot tone={need > 0 ? "owner" : working > 0 ? "ink" : "hollow"} />
            </Flex>
            <Text textStyle="command" lineHeight="16px" color="fg" flex="1" truncate title={repo}>
              {repo.split("/").pop()}
            </Text>
            <Text textStyle="caption" color="fg.subtle">
              {need > 0 ? `${need} need you` : working > 0 ? `${working} working` : "idle"}
            </Text>
          </Flex>
        );
      })}
      <Link href="#/setup" display="flex" alignItems="center" gap="10px" h="30px" px="10px" color="fg.subtle" textStyle="meta" fontSize="12px" lineHeight="16px" textDecoration="none" _hover={{ textDecoration: "none", color: "fg" }}>
        <Box w="16px" textAlign="center" fontSize="14px">
          +
        </Box>
        Add a repo
      </Link>
    </Flex>
  );
}

/** One line: is the daemon alive, and how long since its last tick. The offline banner carries the explanation and the command. */
function DaemonLine({ state }: { state: UiState | null }) {
  const beat = state?.daemonHeartbeatAt ?? null;
  const live = state !== null && beat !== null && state.generatedAt - beat <= 3 * 60_000;
  const secs = state && beat !== null ? Math.max(0, Math.round((state.generatedAt - beat) / 1000)) : null;
  return (
    <Flex align="center" gap="2" px="10px" pt="12px" borderTopWidth="1px" borderTopColor="border" display={{ base: "none", md: "flex" }}>
      <Flex w="16px" justify="center" flexShrink={0}>
        <Dot tone={live ? "passed" : state === null ? "hollow" : "owner"} />
      </Flex>
      <Text textStyle="meta" fontSize="12px" lineHeight="16px" color="fg" flex="1">
        {state === null ? "Daemon unknown" : live ? "Daemon running" : "Daemon offline"}
      </Text>
      {secs !== null ? (
        <Text textStyle="caption" color="fg.subtle">
          {secs < 90 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`}
        </Text>
      ) : null}
    </Flex>
  );
}
