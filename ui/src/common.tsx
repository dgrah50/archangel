import { Badge, Link, Table } from "@chakra-ui/react";
import type { UiItem } from "../../src/core/ui-state.js";
import { threadHash } from "./route";

// Strings from the Ledger (issue titles) are untrusted: they are only ever rendered as React text children,
// never as HTML, and links are only built for repo slugs shaped like owner/name.

export const STATUS_PALETTE: Record<string, string> = {
  working: "blue",
  awaiting_gate: "yellow",
  reviewing: "purple",
  landing: "purple",
  shadow_ready: "green",
  owner_driving: "cyan",
  queued: "gray",
  merged: "green",
  "owner merged": "green",
  "PR closed": "gray",
  abandoned: "gray",
  reverted: "red",
};

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

export function ThreadTable({ items, now }: { items: UiItem[]; now: number }) {
  return (
    <Table.Root size="sm" variant="line">
      <Table.Body>
        {items.map((i) => (
          <Table.Row key={`${i.repo}#${i.issueNumber}`}>
            <Table.Cell whiteSpace="nowrap">
              {/^[\w.-]+\/[\w.-]+$/.test(i.repo) ? <Link href={threadHash({ repo: i.repo, issue: i.issueNumber })}>{`${i.repo}#${i.issueNumber}`}</Link> : `${i.repo}#${i.issueNumber}`}
              {i.prNumber ? (
                <>
                  {" "}
                  <GhLink repo={i.repo} kind="pull" num={i.prNumber}>{`PR #${i.prNumber}`}</GhLink>
                </>
              ) : null}
            </Table.Cell>
            <Table.Cell>{i.title}</Table.Cell>
            <Table.Cell whiteSpace="nowrap">
              <Badge colorPalette={STATUS_PALETTE[i.phase] ?? "gray"}>{i.phase.replace(/_/g, " ")}</Badge>
            </Table.Cell>
            <Table.Cell whiteSpace="nowrap" color="fg.muted" textAlign="end">
              {age(now - i.since)}
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

