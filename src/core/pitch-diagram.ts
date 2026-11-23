/**
 * The host-side shape of a pitch's "what changes" diagram, and its one layout. The model supplies only nodes and edges; the dashboard draws
 * the rows as React text and the issue body prints them as a plain-text tree. No markup, SVG or Mermaid ever comes from the model.
 */

export const DIAGRAM_CHANGES = ["add", "remove", "modify", "same"] as const;
export type DiagramChange = (typeof DIAGRAM_CHANGES)[number];

export interface ChangeDiagram {
  nodes: Array<{ id: string; label: string; change: DiagramChange }>;
  edges: Array<{ from: string; to: string }>;
}

export interface DiagramRow {
  id: string;
  label: string;
  change: DiagramChange;
  depth: number;
  /** The node was already drawn above (a shared child or a cycle): shown once more as a reference, not expanded. */
  repeat: boolean;
}

/** Roots (no incoming edge) in node order, each followed by its children in edge order. A node reached twice is not expanded twice. */
export function diagramRows(d: ChangeDiagram): DiagramRow[] {
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const hasParent = new Set(d.edges.map((e) => e.to));
  const children = (id: string) => d.edges.filter((e) => e.from === id).map((e) => e.to);
  const rows: DiagramRow[] = [];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    const n = byId.get(id)!;
    const repeat = seen.has(id);
    rows.push({ id, label: n.label, change: n.change, depth, repeat });
    if (repeat) return;
    seen.add(id);
    for (const c of children(id)) walk(c, depth + 1);
  };
  for (const n of d.nodes) if (!hasParent.has(n.id)) walk(n.id, 0);
  // A pure cycle has no root: draw whatever is still unseen.
  for (const n of d.nodes) if (!seen.has(n.id)) walk(n.id, 0);
  return rows;
}

const MARK: Record<DiagramChange, string> = { add: "[+]", remove: "[-]", modify: "[~]", same: "[ ]" };

/** The plain-text tree for the GitHub issue body: `[+] added`, `[-] removed`, `[~] changed`, `[ ] unchanged`. */
export function renderDiagramTree(d: ChangeDiagram): string[] {
  return diagramRows(d).map((r) => `${"  ".repeat(r.depth)}${MARK[r.change]} ${r.label}${r.repeat ? " (shown above)" : ""}`);
}
