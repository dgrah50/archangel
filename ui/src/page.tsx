import { Box, Button, Flex, Link, Text, type FlexProps } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { CopyButton } from "./arc/copy-button/copy-button";

// Page primitives for the dashboard. Every page opens with its title and its numbers, then cards (`Section`) or a master-detail pair
// (`MasterDetail`): no shadows. Typography comes from the theme's text styles (headline, rowTitle, label, meta, ref, command ...).
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

/** The page title, with the page's numbers beside it in grey and an optional control (`right`) at the far end. The row is as tall with a control as without one, so the title sits at the same height on every page. */
export function PageHeadline({ title, children, right }: { title: string; children?: ReactNode; right?: ReactNode }) {
  return (
    <Flex align="center" justify="space-between" columnGap="6" rowGap="3" wrap="wrap" minH="44px" mb="5">
      <Flex align="baseline" columnGap="3.5" rowGap="1" wrap="wrap" minW="0">
        <Text as="h1" textStyle="headline" color="fg" flexShrink={0}>
          {title}
        </Text>
        {children ? (
          <Text textStyle="body13" color="fg.muted">
            {children}
          </Text>
        ) : null}
      </Flex>
      {right ? (
        <Flex align="center" gap="3" wrap="wrap" flexShrink={0}>
          {right}
        </Flex>
      ) : null}
    </Flex>
  );
}

/** Master and detail: the selectable list on the bare surface (left, `PickList`), the selected item's blocks (right). Runs edge to edge under the headline; pass the page's own `Page px="0"`. */
export function MasterDetail({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <Flex borderTopWidth="1px" borderTopColor="border" flex="1" minH="0" direction={{ base: "column", lg: "row" }}>
      <Flex direction="column" w={{ lg: "420px" }} flexShrink={0} borderEndWidth={{ lg: "1px" }} borderColor="border" p="3">
        {list}
      </Flex>
      <Box flex="1" minW="0" px={{ base: "6", md: "8" }} py="6">
        {children}
      </Box>
    </Flex>
  );
}

const pickLook = (selected: boolean) => ({ align: "center", gap: "2.5", rounded: "10px", borderWidth: "1px", borderColor: selected ? "border" : "transparent", bg: selected ? "bg.muted" : "transparent", _hover: { textDecoration: "none", bg: selected ? "bg.muted" : "bg.subtle" } }) as const;

/** The one selectable row: a hairline outline and a filled background when selected, a lighter fill on hover. A link when it has an `href`, else a button. */
export function PickRow({ selected, href, onClick, label, children, ...rest }: { selected: boolean; href?: string; onClick?: () => void; label?: string; children: ReactNode } & Omit<FlexProps, "onClick">) {
  const look = { ...pickLook(selected), px: "3", textAlign: "start", textDecoration: "none", color: "inherit", cursor: "pointer", w: "full" } as const;
  return href ? (
    <Flex as="a" {...{ href }} aria-current={selected ? "true" : undefined} aria-label={label} {...look} {...rest}>
      {children}
    </Flex>
  ) : (
    <Flex as="button" {...{ type: "button" }} onClick={onClick} aria-pressed={selected} aria-label={label} {...look} {...rest}>
      {children}
    </Flex>
  );
}

/** A group of rows under a filled header band; folds like the native disclosure it is. Absent when empty. `n` is the count beside the label. */
export function Group({ label, n, tone, folded, children }: { label: string; n: number; tone: Tone; folded?: boolean; children: ReactNode }) {
  if (n === 0) return null;
  return (
    <Box as="details" {...{ open: !folded }} css={{ "&[open] > summary > svg": { transform: "rotate(90deg)" } }}>
      <Flex as="summary" align="center" gap="2.5" h="36px" px="3" rounded="10px" bg="bg.subtle" cursor="pointer" listStyleType="none" css={{ "&::-webkit-details-marker": { display: "none" } }}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" style={{ flexShrink: 0, color: "var(--chakra-colors-fg-subtle)" }}>
          <path d="M3.5 1.5L7 5L3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <Dot tone={tone} />
        <Text textStyle="label" color="fg">
          {label}
        </Text>
        <Text textStyle="body13" color="fg.subtle">
          {n}
        </Text>
      </Flex>
      <Box py="1">{children}</Box>
    </Box>
  );
}

/** A section: a card at rest (panel fill, hairline border, surface radius). `inner` marks a section inside a card, which gets a hairline instead of its own card. */
export function Section({ inner, children, ...rest }: { inner?: boolean; children: ReactNode } & FlexProps) {
  return (
    <Flex as="section" direction="column" gap="3.5" {...(inner ? { borderTopWidth: "1px", borderColor: "border", pt: "4" } : { bg: "bg.panel", borderWidth: "1px", borderColor: "border", rounded: "surface", p: "5" })} {...rest}>
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

export type Tone = "ink" | "owner" | "passed" | "hollow" | "ring";

/** One line of a list: status dot, title, grey context, an optional chip, and how long it has been there. The title links to `href`; `selected` marks the open item of a master-detail list. */
export function Line({ tone, href, title, meta, chip, when, selected = false }: { tone: Tone; href?: string; title: string; meta: ReactNode; chip?: ReactNode; when: string; selected?: boolean }) {
  const text = (
    <>
      <Text as="span" textStyle="label" color="fg" truncate flexShrink={0} maxW="64%">
        {title}
      </Text>
      <Text as="span" textStyle="meta" color="fg.muted" truncate minW="0">
        {meta}
      </Text>
    </>
  );
  return (
    <Flex {...pickLook(selected)} h="40px" ps="34px" pe="3">
      <Dot tone={tone} />
      {href ? (
        <Link href={href} aria-current={selected ? "true" : undefined} display="flex" alignItems="baseline" gap="2.5" flex="1" minW="0" color="inherit" textDecoration="none" _hover={{ textDecoration: "none" }}>
          {text}
        </Link>
      ) : (
        <Flex align="baseline" gap="2.5" flex="1" minW="0">
          {text}
        </Flex>
      )}
      {chip}
      <Text textStyle="meta" color="fg.subtle" w="40px" textAlign="end" flexShrink={0}>
        {when}
      </Text>
    </Flex>
  );
}

/** A 7px status dot: `ink` (solid), `owner` (amber), `passed` (green, pair with a text label), `ring` (ink outline) or `hollow` (grey outline). */
export function Dot({ tone = "ink" }: { tone?: Tone }) {
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

/** A validation error as readable lines: the server joins its `path: message` issues with "; ". */
export function Issues({ text }: { text: string }) {
  return (
    <Flex direction="column" gap="1">
      {text.split("; ").map((line, i) => {
        const at = line.indexOf(": ");
        return (
          <Text key={i} textStyle="meta" color="fg.muted" wordBreak="break-word">
            {at > 0 ? <Text as="span" textStyle="ref">{line.slice(0, at)}</Text> : null}
            {at > 0 ? line.slice(at) : line}
          </Text>
        );
      })}
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
