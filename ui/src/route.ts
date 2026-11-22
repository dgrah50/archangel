/** Hash routes (`#/pipeline`): no router library. Pure, so every route is testable. */
export interface ItemRef {
  repo: string;
  issue: number;
}
export type Route =
  | { page: "overview" }
  | { page: "needs-you"; item: ItemRef | null }
  | { page: "threads" }
  | { page: "pipeline" }
  | { page: "not-found"; hash: string };

type NavPage = "overview" | "needs-you" | "threads" | "pipeline";
export const NAV: ReadonlyArray<{ page: NavPage; label: string; hash: string }> = [
  { page: "overview", label: "Overview", hash: "#/" },
  { page: "needs-you", label: "Needs you", hash: "#/needs-you" },
  { page: "threads", label: "Threads", hash: "#/threads" },
  { page: "pipeline", label: "Pipeline", hash: "#/pipeline" },
];

const SLUG = /^[\w.-]+\/[\w.-]+$/;
export const itemHash = (i: ItemRef) => `#/needs-you/${i.repo}/${i.issue}`;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/\/+$/, "");
  if (path === "") return { page: "overview" };
  if (path === "/pipeline") return { page: "pipeline" };
  if (path === "/threads") return { page: "threads" };
  if (path === "/needs-you") return { page: "needs-you", item: null };
  const m = /^\/needs-you\/([^/]+\/[^/]+)\/(\d+)$/.exec(path);
  if (m && SLUG.test(m[1]!)) return { page: "needs-you", item: { repo: m[1]!, issue: Number(m[2]) } };
  return { page: "not-found", hash };
}
