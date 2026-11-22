import { Badge, Box, Button, Card, Flex, Link, Stack, Text } from "@chakra-ui/react";
import { useState } from "react";
import type { UiState } from "../../src/core/ui-state.js";
import { GhLink, age } from "./common";
import { itemHash, threadHash, type ItemRef } from "./route";

type Item = UiState["needsYou"][number];
const SLUG = /^[\w.-]+\/[\w.-]+$/;
const same = (i: Item, r: ItemRef) => i.repo === r.repo && i.issueNumber === r.issue;

/** The next item after `current` in the queue (wraps), or null when there is nothing else to look at. */
export function nextItem(queue: Item[], current: Item | null): Item | null {
  if (queue.length < 2 || current === null) return null;
  const at = queue.indexOf(current);
  return queue[(at + 1) % queue.length]!;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? "Copied" : `Copy ${text}`}
    </Button>
  );
}

/** Read-only: opening an item does not answer it. Answering happens on GitHub; nothing here posts. */
export function NeedsYouPage({ state, item }: { state: UiState; item: ItemRef | null }) {
  const queue = state.needsYou;
  if (queue.length === 0) {
    return (
      <Box maxW="64rem" mx="auto" p="6">
        <Box borderWidth="1px" borderStyle="dashed" rounded="xl" p="5" color="fg.muted" textAlign="center">
          Nothing needs you.
        </Box>
      </Box>
    );
  }
  const selected = item === null ? queue[0]! : (queue.find((i) => same(i, item)) ?? null);
  const next = nextItem(queue, selected);
  return (
    <Flex maxW="64rem" mx="auto" p="6" gap="6" direction={{ base: "column", md: "row" }}>
      <Stack as="ul" listStyleType="none" gap="2" w={{ md: "20rem" }} flexShrink={0} aria-label="Queue (oldest first)">
        {queue.map((i) => (
          <li key={`${i.repo}#${i.issueNumber}`}>
            <Card.Root borderLeftWidth="4px" borderLeftColor={selected === i ? "orange.solid" : "border"}>
              <Card.Body py="2" px="3">
                <Link href={itemHash({ repo: i.repo, issue: i.issueNumber })} aria-current={selected === i ? "true" : undefined} textDecoration="none" fontWeight={selected === i ? "semibold" : "normal"}>
                  {i.repo}#{i.issueNumber} {i.title}
                </Link>
                <Text color="fg.muted" textStyle="xs">
                  {i.decisionClass}, waiting {age(state.generatedAt - i.since)}
                </Text>
              </Card.Body>
            </Card.Root>
          </li>
        ))}
      </Stack>
      <Box flex="1" minW="0">
        {selected === null ? (
          <Box role="status" borderWidth="1px" rounded="xl" p="5">
            <Text>That item no longer needs you.</Text>
            <Link href="#/needs-you">Back to the queue</Link>
          </Box>
        ) : (
          <Card.Root>
            <Card.Body>
              <Text fontWeight="medium" textStyle="lg">
                {selected.title}
              </Text>
              <Text color="fg.muted" textStyle="sm" mt="1">
                <Badge colorPalette="orange" mr="2">
                  {selected.decisionClass}
                </Badge>
                {selected.code}, waiting {age(state.generatedAt - selected.since)}
              </Text>
              <Text mt="3" fontWeight="medium">
                Why
              </Text>
              <Text>{selected.reason}</Text>
              <Text mt="3" fontWeight="medium">
                Recommendation
              </Text>
              <Text>{selected.recommendation}</Text>
              <Flex gap="2" mt="4" wrap="wrap" align="center">
                {SLUG.test(selected.repo) ? (
                  <Button asChild size="sm">
                    <a href={ghUrl(selected)} target="_blank" rel="noreferrer noopener">
                      Answer on GitHub
                    </a>
                  </Button>
                ) : null}
                <CopyButton text="/archangel retry" />
                <Button asChild size="sm" variant="outline">
                  <a href={threadHash({ repo: selected.repo, issue: selected.issueNumber })}>Timeline</a>
                </Button>
                {next ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={itemHash({ repo: next.repo, issue: next.issueNumber })}>Next</a>
                  </Button>
                ) : null}
              </Flex>
              <Text color="fg.muted" textStyle="xs" mt="2">
                Archangel never replies for you: open the {selected.prNumber ? "PR" : "issue"} and comment there.{" "}
                <GhLink repo={selected.repo} kind="issues" num={selected.issueNumber}>{`${selected.repo}#${selected.issueNumber}`}</GhLink>
              </Text>
            </Card.Body>
          </Card.Root>
        )}
      </Box>
    </Flex>
  );
}

function ghUrl(i: Item): string {
  return `https://github.com/${i.repo}/${i.prNumber ? "pull" : "issues"}/${i.prNumber ?? i.issueNumber}`;
}
