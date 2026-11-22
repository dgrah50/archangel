import { useCallback, useEffect, useState } from "react";
import type { Feed } from "./AppView";
import { POLL_MS } from "./AppView";
import { fetchFeed } from "./payload";

const empty = <T,>(): Feed<T> => ({ data: null, at: null, error: null });

/** One page-scoped feed: polls only while `enabled`, keeps the last good data across failures. */
export function useFeed<T>(url: string, valid: (v: unknown) => v is T, enabled = true): [Feed<T>, () => void] {
  const [feed, setFeed] = useState<Feed<T>>(empty());
  const load = useCallback(() => {
    fetchFeed(url, valid).then(
      (data) => setFeed({ data, at: Date.now(), error: null }),
      (e: unknown) => setFeed((f) => ({ ...f, error: e instanceof Error ? e.message : String(e) })),
    );
  }, [url, valid]);
  useEffect(() => {
    if (!enabled) return;
    load();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
  }, [enabled, load]);
  return [feed, load];
}

/** Current hash, updated on navigation. */
export function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}
