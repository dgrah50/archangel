import { Box, Button, Flex, Link, Text, type FlexProps } from "@chakra-ui/react";
import { useState, type ReactNode } from "react";

// Page primitives for the dashboard redesign. Every page opens with a plain-sentence headline, then sections of hairline-separated rows
// on the surface: no cards, no shadows. Typography comes from the theme's text styles (headline, rowTitle, label, meta, ref, command ...).
// Colour language: amber (`owner`) = only the owner can move this, or the factory is about to stop; violet (`unsent`) outlines unsent edits;
// green (`passed`) marks a passed check next to a text label; everything else is ink and grey.

const SLUG = /^[\w.-]+\/[\w.-]+$/;

/** A page body: the headline, then its sections. Page padding lives here, so existing pages that bring their own padding are not wrapped in it. */
export function Page({ children, ...rest }: { children: ReactNode } & FlexProps) {
  return (
    <Flex direction="column" px={{ base: "6", md: "56px" }} pt="34px" pb="30px" minH="100vh" {...rest}>
      {children}
    </Flex>
  );
}

/** One plain sentence stating the situation, plus one grey sentence under it. Wrap the words that need the owner in <Owed>. */
export function PageHeadline({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <Flex direction="column" gap="1" pt="10px" pb="6">
      <Text as="h1" textStyle="headline" color="fg">
        {children}
      </Text>
      {sub ? (
        <Text textStyle="headlineSub" color="fg.subtle">
          {sub}
        </Text>
      ) : null}
    </Flex>
  );
}

/** Amber text for the part of a sentence only the owner can move. */
export function Owed({ children }: { children: ReactNode }) {
  return (
    <Box as="span" color="owner">
      {children}
    </Box>
  );
}

/** A section: starts with a 1px ink rule. `title` is the optional grey lead-in sentence. */
export function Section({ title, children, ...rest }: { title?: ReactNode; children: ReactNode } & FlexProps) {
  return (
    <Flex as="section" direction="column" gap="3.5" borderTopWidth="1px" borderTopColor="fg" pt="3" {...rest}>
      {title ? (
        <Text textStyle="meta" fontSize="12px" color="fg.subtle">
          {title}
        </Text>
      ) : null}
      {children}
    </Flex>
  );
}

/** Rows of one section: an ink rule on top, light hairlines between rows and under the last. */
export function RowList({ children, ...rest }: { children: ReactNode } & FlexProps) {
  return (
    <Flex direction="column" borderTopWidth="1px" borderTopColor="fg" borderBottomWidth="1px" borderBottomColor="border" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }} {...rest}>
      {children}
    </Flex>
  );
}

/** One row: a fixed 52px lead (age, count), the body (title over meta line), and an action. Pass `owed` when only the owner can move it. */
export function Row({ lead, owed, title, meta, action }: { lead: ReactNode; owed?: boolean; title: ReactNode; meta: ReactNode; action?: ReactNode }) {
  return (
    <Flex align="center" gap="4" h="62px" flexShrink={0}>
      <Text textStyle="figure" color={owed ? "owner" : "fg.subtle"} w="52px" flexShrink={0}>
        {lead}
      </Text>
      <Flex direction="column" gap="1px" flex="1" minW="0">
        <Text textStyle="rowTitle" color="fg" truncate>
          {title}
        </Text>
        <Text textStyle="meta" color="fg.muted" truncate>
          {meta}
        </Text>
      </Flex>
      {action}
    </Flex>
  );
}

/** A button that is a link (to GitHub or another page). The dashboard never acts: it only links. */
export function LinkButton({ href, primary, external, children }: { href: string; primary?: boolean; external?: boolean; children: ReactNode }) {
  return (
    <Button asChild size="sm" variant={primary ? "solid" : "outline"} flexShrink={0} borderRadius="12px">
      <a href={href} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}>
        {children}
      </a>
    </Button>
  );
}

/** repo#issue in mono. Shows the repo name without its owner; links to `href` when given and the repo slug is well formed. */
export function Ref({ repo, num, href }: { repo: string; num: number; href?: string }) {
  const text = `${repo.split("/").pop()}#${num}`;
  const node = (
    <Text as="span" textStyle="ref">
      {text}
    </Text>
  );
  return href && SLUG.test(repo) ? (
    <Link href={href} color="inherit">
      {node}
    </Link>
  ) : (
    node
  );
}

/** A metric: label, one big number (with an optional aside), and one sentence saying what it is for and what clears it. */
export function Metric({ label, value, aside, visual, children }: { label: string; value: ReactNode; aside?: ReactNode; visual?: ReactNode; children: ReactNode }) {
  return (
    <Section flex="1" minW="0" gap="1.5">
      <Text textStyle="label" fontSize="12.5px" lineHeight="17px" color="fg">
        {label}
      </Text>
      <Flex align="center" gap="4">
        <Text textStyle="bigNumber" color="fg" whiteSpace="pre">
          {value}
          {aside ? (
            <Box as="span" fontSize="14px" fontWeight="400" letterSpacing="body" color="fg.subtle">
              {" "}
              {aside}
            </Box>
          ) : null}
        </Text>
        {visual}
      </Flex>
      <Text textStyle="meta" color="fg.muted" lineHeight="17px">
        {children}
      </Text>
    </Section>
  );
}

/** A thin progress bar in ink on a muted track. */
export function Meter({ fraction }: { fraction: number }) {
  return (
    <Box flex="1" h="4px" rounded="2px" bg="bg.muted">
      <Box h="4px" rounded="2px" bg="fg" w={`${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`} />
    </Box>
  );
}

/** A small trend line in ink with a dot on the latest point. `values` may hold nulls (no data that day): they are skipped. */
export function Sparkline({ values, label }: { values: Array<number | null>; label: string }) {
  const w = 150;
  const h = 24;
  const pts = values.map((v, i) => (v === null ? null : { i, v })).filter((p): p is { i: number; v: number } => p !== null);
  if (pts.length < 2) return null;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const x = (i: number) => 2 + (i / Math.max(1, values.length - 1)) * (w - 8);
  const y = (v: number) => (hi === lo ? h / 2 : 5 + ((hi - v) / (hi - lo)) * (h - 10));
  const last = pts[pts.length - 1]!;
  return (
    <svg role="img" aria-label={label} width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ flexShrink: 0, color: "var(--chakra-colors-fg)" }}>
      <polyline points={pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={x(last.i)} cy={y(last.v)} r="2.5" fill="currentColor" />
    </svg>
  );
}

/** A 7px status dot: `ink` (solid), `owner` (amber), `passed` (green, pair with a text label), or `hollow`. */
export function Dot({ tone = "ink" }: { tone?: "ink" | "owner" | "passed" | "hollow" }) {
  return <Box w="7px" h="7px" rounded="full" flexShrink={0} boxSizing="border-box" {...(tone === "hollow" ? { borderWidth: "1.5px", borderColor: "border.emphasized" } : { bg: tone === "ink" ? "fg" : tone })} />;
}

/** A count that only the owner can clear: amber pill. */
export function OwedCount({ children }: { children: ReactNode }) {
  return (
    <Flex align="center" justify="center" h="20px" minW="20px" px="6px" rounded="10px" bg="owner" color="bg" textStyle="caption" fontWeight="600">
      {children}
    </Flex>
  );
}

/** A command to copy and run by hand: the dashboard never restarts anything itself. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Flex align="center" gap="2" minH="30px" py="1" px="10px" rounded="10px" borderWidth="1px" borderColor="border" bg="bg.subtle">
      <Text textStyle="command" color="fg" flex="1" wordBreak="break-all">
        {command}
      </Text>
      <Button
        variant="plain"
        size="xs"
        h="auto"
        minW="0"
        p="0"
        color="fg.muted"
        fontWeight="400"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => undefined);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </Flex>
  );
}
