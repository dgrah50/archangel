import { isMap, isSeq, parseDocument, type Document } from "yaml";

/** Pure YAML edits for archangel.yaml. They go through a `yaml` Document, so comments and layout outside the edit survive. */
export type Provider = "codex" | "agy" | "claude";
export const PROVIDERS: readonly Provider[] = ["codex", "agy", "claude"];
/** Mirrors providerToVendor in src/config.ts (which cannot be imported into the browser: it pulls in node:fs). A test pins them together. */
export const VENDOR: Record<Provider, string> = { codex: "openai", agy: "gemini", claude: "anthropic" };

export interface ChainEntry {
  provider: Provider;
  model?: string;
}
export const WRITER_CHAINS = ["implement", "revise", "rebase"] as const;
export interface HostForm {
  ownerUserId: number | null;
  authMode: string;
  dailyTimezone: string;
  digestHour: number;
  maxDailyUsd: number;
  maxAutonomousStepsWithoutOwner: number;
  maxImplementAttemptsPerThread: number;
  maxRevisionsPerThread: number;
  maxRebasesPerThread: number;
  chains: Record<(typeof WRITER_CHAINS)[number], ChainEntry[]>;
  reviewerChain: ChainEntry[];
}

type Path = Array<string | number>;
const DEFAULT_CHAIN: ChainEntry[] = [{ provider: "codex" }, { provider: "agy" }];
const DEFAULT_REVIEWERS: ChainEntry[] = [{ provider: "agy" }, { provider: "claude" }, { provider: "codex" }];

function doc(text: string): Document {
  const d = parseDocument(text);
  if (d.errors.length > 0) throw new Error(d.errors[0]!.message);
  if (!isMap(d.contents)) throw new Error("archangel.yaml must be a mapping");
  return d;
}
const edit = (text: string, fn: (d: Document) => void): string => {
  const d = doc(text);
  fn(d);
  return d.toString();
};

export function editField(text: string, path: Path, value: unknown): string {
  return edit(text, (d) => d.setIn(path, value));
}
/** Adds a project the way the wizard onboards one: shadow mode on and Scouts off. */
export function addProject(text: string, repo: string): string {
  return edit(text, (d) => d.addIn(["projects"], { repo, shadowMode: true, scouts: { enabled: false } }));
}
export function setChainEntry(text: string, chain: Path, i: number, entry: ChainEntry): string {
  return edit(text, (d) => {
    d.setIn([...chain, i, "provider"], entry.provider);
    if (entry.model) d.setIn([...chain, i, "model"], entry.model);
    else d.deleteIn([...chain, i, "model"]);
  });
}
export function addChainEntry(text: string, chain: Path, provider: Provider): string {
  return edit(text, (d) => {
    if (isSeq(d.getIn(chain))) d.addIn(chain, { provider });
    else d.setIn(chain, [{ provider }]);
  });
}
export function removeChainEntry(text: string, chain: Path, i: number): string {
  return edit(text, (d) => d.deleteIn([...chain, i]));
}
export function moveChainEntry(text: string, chain: Path, i: number, by: -1 | 1): string {
  return edit(text, (d) => {
    const seq = d.getIn(chain);
    const j = i + by;
    if (!isSeq(seq) || j < 0 || j >= seq.items.length) return;
    [seq.items[i], seq.items[j]] = [seq.items[j]!, seq.items[i]!];
  });
}

/** The form's view of the text, with the schema's defaults for absent keys; null when the text is not a parsable mapping. */
export function readForm(text: string): HostForm | null {
  let j: Record<string, unknown>;
  try {
    j = doc(text).toJS() as Record<string, unknown>;
  } catch {
    return null;
  }
  const num = (k: string, d: number) => (typeof j[k] === "number" ? (j[k] as number) : d);
  const chain = (v: unknown, d: ChainEntry[]) => (Array.isArray(v) ? (v as ChainEntry[]).map((e) => ({ provider: e.provider, ...(e.model ? { model: e.model } : {}) })) : d);
  const c = (j.chains ?? {}) as Record<string, unknown>;
  return {
    ownerUserId: typeof j.ownerUserId === "number" ? j.ownerUserId : null,
    authMode: typeof j.authMode === "string" ? j.authMode : "subscription",
    dailyTimezone: typeof j.dailyTimezone === "string" ? j.dailyTimezone : "America/New_York",
    digestHour: num("digestHour", 9),
    maxDailyUsd: num("maxDailyUsd", 20),
    maxAutonomousStepsWithoutOwner: num("maxAutonomousStepsWithoutOwner", 25),
    maxImplementAttemptsPerThread: num("maxImplementAttemptsPerThread", 3),
    maxRevisionsPerThread: num("maxRevisionsPerThread", 1),
    maxRebasesPerThread: num("maxRebasesPerThread", 1),
    chains: { implement: chain(c.implement, DEFAULT_CHAIN), revise: chain(c.revise, DEFAULT_CHAIN), rebase: chain(c.rebase, DEFAULT_CHAIN) },
    reviewerChain: chain(j.reviewerChain, DEFAULT_REVIEWERS),
  };
}

/**
 * ADR-0003: the reviewers must not share a vendor with the writer. Whichever vendor in a writer chain ends up writing, two other
 * vendors from the reviewer chain must remain (the daemon resolves reviewers per Thread, so overlap alone is not a fault).
 * Subscription mode only: api mode fixes the reviewers.
 */
export function checkIndependence(f: Pick<HostForm, "chains" | "reviewerChain" | "authMode">): { problems: string[]; writers: string[]; reviewers: string[] } {
  const vendors = (c: ChainEntry[]) => [...new Set(c.map((e) => VENDOR[e.provider]).filter(Boolean))];
  const writers = vendors(WRITER_CHAINS.flatMap((r) => f.chains[r]));
  const reviewers = vendors(f.reviewerChain);
  const problems = f.authMode === "api" ? [] : writers.flatMap((w) => {
    const left = reviewers.filter((v) => v !== w);
    return left.length >= 2 ? [] : [`If ${w} writes, only ${left.length} independent reviewer vendor${left.length === 1 ? "" : "s"} remain (${left.join(", ") || "none"}); 2 are required.`];
  });
  return { problems, writers, reviewers };
}

export interface HostChange {
  key: string;
  label: string;
  from: string;
  to: string;
  /** Only limits have a direction: a bigger cap gives the factory more room. */
  direction: "looser" | "stricter" | null;
}
const LIMITS: Array<[keyof HostForm, string, (n: number) => string]> = [
  ["maxDailyUsd", "Spend per day", (n) => `$${n}`],
  ["maxAutonomousStepsWithoutOwner", "Steps without you", String],
  ["maxImplementAttemptsPerThread", "Attempts per Thread", String],
  ["maxRevisionsPerThread", "Revisions per Thread", String],
  ["maxRebasesPerThread", "Rebases per Thread", String],
];
const CHAINS: Array<[string, string, (f: HostForm) => ChainEntry[]]> = [
  ["implement", "Build models", (f) => f.chains.implement],
  ["revise", "Revise models", (f) => f.chains.revise],
  ["rebase", "Rebase models", (f) => f.chains.rebase],
  ["review", "Review models", (f) => f.reviewerChain],
];
export const chainText = (c: ChainEntry[]) => c.map((e) => (e.model ? `${e.provider} ${e.model}` : e.provider)).join(", then ");

/** What the unsaved text changes against the saved text, in the form's own terms. */
export function hostChanges(baseText: string, text: string): HostChange[] {
  const a = readForm(baseText);
  const b = readForm(text);
  if (!a || !b) return [];
  const out: HostChange[] = [];
  for (const [k, label, show] of LIMITS) {
    const x = a[k] as number;
    const y = b[k] as number;
    if (x !== y) out.push({ key: k, label, from: show(x), to: show(y), direction: y > x ? "looser" : "stricter" });
  }
  for (const [k, label] of [["ownerUserId", "Owner user id"], ["digestHour", "Digest hour"], ["dailyTimezone", "Timezone"], ["authMode", "Sign-in"]] as const) {
    if (a[k] !== b[k]) out.push({ key: k, label, from: String(a[k] ?? "none"), to: String(b[k] ?? "none"), direction: null });
  }
  for (const [k, label, get] of CHAINS) {
    if (chainText(get(a)) !== chainText(get(b))) out.push({ key: k, label, from: chainText(get(a)), to: chainText(get(b)), direction: null });
  }
  return out;
}
