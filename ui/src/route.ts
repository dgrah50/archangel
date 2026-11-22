/** Hash routes (`#/pipeline`): no router library. Pure, so every route is testable. */
export interface ItemRef {
  repo: string;
  issue: number;
}
export type Route =
  | { page: "overview" }
  | { page: "needs-you"; item: ItemRef | null }
  | { page: "threads" }
  | { page: "thread"; item: ItemRef }
  | { page: "pipeline" }
  | { page: "pitches" }
  | { page: "health" }
  | { page: "evals" }
  | { page: "setup"; repo: string | null }
  | { page: "settings"; scope: "machine" | "repo" | "kernel" | "raw" }
  | { page: "not-found"; hash: string };

export type NavPage = "overview" | "needs-you" | "threads" | "pipeline" | "pitches" | "settings" | "setup";
export const NAV: ReadonlyArray<{ page: NavPage; label: string; hash: string }> = [
  { page: "overview", label: "Overview", hash: "#/" },
  { page: "needs-you", label: "Needs you", hash: "#/needs-you" },
  { page: "threads", label: "Threads", hash: "#/threads" },
  { page: "pipeline", label: "Pipeline", hash: "#/pipeline" },
  { page: "pitches", label: "Pitches", hash: "#/pitches" },
  { page: "settings", label: "Settings", hash: "#/settings" },
  { page: "setup", label: "Setup and health", hash: "#/setup" },
];

/** The nav item a route lives under (Health and Evals stay reachable by URL; they sit under Setup and health). */
export function navPageOf(route: Route): NavPage | null {
  switch (route.page) {
    case "thread":
      return "threads";
    case "health":
    case "evals":
      return "setup";
    case "not-found":
      return null;
    default:
      return route.page;
  }
}

const SLUG = /^[\w.-]+\/[\w.-]+$/;
export const threadHash = (i: ItemRef) => `#/threads/${i.repo}/${i.issue}`;
export const itemHash = (i: ItemRef) => `#/needs-you/${i.repo}/${i.issue}`;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/\/+$/, "");
  if (path === "") return { page: "overview" };
  if (path === "/pipeline") return { page: "pipeline" };
  if (path === "/pitches") return { page: "pitches" };
  if (path === "/settings") return { page: "settings", scope: "machine" };
  if (path === "/settings/repo") return { page: "settings", scope: "repo" };
  if (path === "/settings/raw") return { page: "settings", scope: "raw" };
  if (path === "/settings/kernel") return { page: "settings", scope: "kernel" };
  if (path === "/setup") return { page: "setup", repo: null };
  const su = /^\/setup\/([^/]+\/[^/]+)$/.exec(path);
  if (su && SLUG.test(su[1]!)) return { page: "setup", repo: su[1]! };
  if (path === "/evals") return { page: "evals" };
  if (path === "/health") return { page: "health" };
  if (path === "/threads") return { page: "threads" };
  if (path === "/needs-you") return { page: "needs-you", item: null };
  const t = /^\/threads\/([^/]+\/[^/]+)\/(\d+)$/.exec(path);
  if (t && SLUG.test(t[1]!)) return { page: "thread", item: { repo: t[1]!, issue: Number(t[2]) } };
  const m = /^\/needs-you\/([^/]+\/[^/]+)\/(\d+)$/.exec(path);
  if (m && SLUG.test(m[1]!)) return { page: "needs-you", item: { repo: m[1]!, issue: Number(m[2]) } };
  return { page: "not-found", hash };
}
