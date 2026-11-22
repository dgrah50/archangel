/** Hash routes (`#/pipeline`): no router library. Pure, so every route is testable. */
export type Route = { page: "overview" } | { page: "pipeline" } | { page: "not-found"; hash: string };

export const NAV: ReadonlyArray<{ page: "overview" | "pipeline"; label: string; hash: string }> = [
  { page: "overview", label: "Overview", hash: "#/" },
  { page: "pipeline", label: "Pipeline", hash: "#/pipeline" },
];

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/\/+$/, "");
  if (path === "") return { page: "overview" };
  if (path === "/pipeline") return { page: "pipeline" };
  return { page: "not-found", hash };
}
