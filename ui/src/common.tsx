export function age(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Row-sized recommendation: the per-Thread headline cut at a word boundary, else the class-level short form. */
export function recommendationShort(i: { recommendationShort: string; threadRecommendation: { headline: string } | null }, max = 50): string {
  const h = i.threadRecommendation?.headline;
  if (!h) return i.recommendationShort;
  if (h.length <= max) return h;
  const cut = h.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 20)).replace(/[\s,.;:]+$/, "")}...`;
}
