import { Box, Button, Flex, Link, Text, type FlexProps } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { CopyButton } from "./arc/copy-button/copy-button";

// Page primitives for the dashboard redesign. Every page opens with its title and its numbers, then sections of hairline-separated rows
// on the surface: no cards, no shadows. Typography comes from the theme's text styles (headline, rowTitle, label, meta, ref, command ...).
// Colour language: amber (`owner`) = only the owner can move this, or the factory is about to stop; violet (`unsent`) outlines unsent edits;
// green (`passed`) marks a passed check next to a text label; everything else is ink and grey.

const SLUG = /^[\w.-]+\/[\w.-]+$/;

/** A page body: the headline, then its sections. Page padding lives here, so existing pages that bring their own padding are not wrapped in it. */
export function Page({ children, ...rest }: { children: ReactNode } & FlexProps) {
  return (
    <Flex direction="column" flex="1" px={{ base: "6", md: "56px" }} pt="7" pb="8" {...rest}>
      {children}
    </Flex>
  );
}

/** The page title, with the page's numbers beside it in grey. The numbers are the only part that changes, so they are data, not a sentence. */
export function PageHeadline({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Flex align="baseline" columnGap="3.5" rowGap="1" wrap="wrap" pb="5">
      <Text as="h1" textStyle="headline" color="fg" flexShrink={0}>
        {title}
      </Text>
      {children ? (
        <Text textStyle="body13" color="fg.muted">
          {children}
        </Text>
      ) : null}
    </Flex>
  );
}

/** A section: a card at rest (panel fill, hairline border, surface radius). `title` is the optional grey lead-in sentence; `inner` marks a section inside a card, which gets a hairline instead of its own card. */
export function Section({ title, inner, children, ...rest }: { title?: ReactNode; inner?: boolean; children: ReactNode } & FlexProps) {
  return (
    <Flex as="section" direction="column" gap="3.5" {...(inner ? { borderTopWidth: "1px", borderColor: "border", pt: "4" } : { bg: "bg.panel", borderWidth: "1px", borderColor: "border", rounded: "surface", p: "5" })} {...rest}>
      {title ? (
        <Text textStyle="meta" fontSize="12px" color="fg.subtle">
          {title}
        </Text>
      ) : null}
      {children}
    </Flex>
  );
}

/** Rows of one section: light hairlines above and between rows. */
export function RowList({ children, ...rest }: { children: ReactNode } & FlexProps) {
  return (
    <Flex direction="column" borderTopWidth="1px" borderTopColor="border" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }} {...rest}>
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

/** Plain text where `backticked` spans are commands: they render in mono, without the backticks. */
export function Ticked({ children }: { children: string }) {
  return (
    <>
      {children.split("`").map((part, i) =>
        i % 2 === 1 ? (
          <Text as="code" key={i} textStyle="command" fontSize="0.92em" lineHeight="inherit" bg="bg.muted" rounded="4px" px="4px" py="1px" whiteSpace="nowrap">
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </>
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

/** A 7px status dot: `ink` (solid), `owner` (amber), `passed` (green, pair with a text label), `ring` (ink outline) or `hollow` (grey outline). */
export function Dot({ tone = "ink" }: { tone?: "ink" | "owner" | "passed" | "hollow" | "ring" }) {
  return <Box w="7px" h="7px" rounded="full" flexShrink={0} boxSizing="border-box" {...(tone === "hollow" || tone === "ring" ? { borderWidth: "1.5px", borderColor: tone === "ring" ? "fg" : "border.emphasized" } : { bg: tone === "ink" ? "fg" : tone })} />;
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
  return (
    <Flex align="center" gap="2" minH="36px" py="1" ps="12px" pe="1" rounded="10px" borderWidth="1px" borderColor="border" bg="bg.subtle">
      <Text textStyle="command" color="fg" flex="1" wordBreak="break-all">
        {command}
      </Text>
      <CopyButton value={command} variant="plain" />
    </Flex>
  );
}
