import { Link } from "@chakra-ui/react";

// Strings from the Ledger (issue titles) are untrusted: they are only ever rendered as React text children,
// never as HTML, and links are only built for repo slugs shaped like owner/name.

export function age(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function GhLink({ repo, kind, num, children }: { repo: string; kind: "issues" | "pull"; num: number; children: string }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return <>{children}</>;
  return (
    <Link href={`https://github.com/${repo}/${kind}/${num}`} rel="noreferrer noopener" target="_blank">
      {children}
    </Link>
  );
}

/** Row-sized recommendation: the per-Thread headline cut at a word boundary, else the class-level short form. */
export function recommendationShort(i: { recommendationShort: string; threadRecommendation: { headline: string } | null }, max = 50): string {
  const h = i.threadRecommendation?.headline;
  if (!h) return i.recommendationShort;
  if (h.length <= max) return h;
  const cut = h.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 20)).replace(/[\s,.;:]+$/, "")}...`;
}
