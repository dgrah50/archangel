import { Box, Flex, Link, Text } from "@chakra-ui/react";
import type { ReactNode } from "react";
import type { ThreadDetail } from "../../src/core/ui-thread.js";
import type { UiState } from "../../src/core/ui-state.js";
import type { Feed } from "./AppView";
import { age, recommendationShort } from "./common";
import { CopyCommand, Dot, LinkButton, Owed, Page, PageHeadline, Ref, Section, Ticked } from "./page";
import { itemHash, threadHash, type ItemRef } from "./route";

type Item = UiState["needsYou"][number];
const SLUG = /^[\w.-]+\/[\w.-]+$/;
const same = (i: Item, r: ItemRef) => i.repo === r.repo && i.issueNumber === r.issue;
const gap = (ms: number) => age(ms).replace(/(\d)([a-z])/, "$1 $2");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ghUrl = (i: Item) => `https://github.com/${i.repo}/${i.prNumber ? "pull" : "issues"}/${i.prNumber ?? i.issueNumber}`;

/** The next item after `current` in the queue (wraps), or null when there is nothing else to look at. */
export function nextItem(queue: Item[], current: Item | null): Item | null {
  if (queue.length < 2 || current === null) return null;
  const at = queue.indexOf(current);
  return queue[(at + 1) % queue.length]!;
}

const clock = (ts: number, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);

/** Decisions answered today (local day per `dailyTimezone`): plain grey rows, the ref in mono. */
function AnsweredToday({ answered }: { answered: UiState["answeredToday"] }) {
  if (answered.items.length === 0) return null;
  return (
    <Flex direction="column" gap="2" mt="auto" pt="4" borderTopWidth="1px" borderTopColor="border">
      <Text textStyle="meta" color="fg.muted">
        Answered today
      </Text>
      {answered.items.map((a) => (
        <Flex key={`${a.repo}#${a.issueNumber}`} gap="4" textStyle="meta" color="fg.muted">
          <Text textStyle="ref" w="150px" flexShrink={0} truncate>
            <Ref repo={a.repo} num={a.issueNumber} />
          </Text>
          <Text flex="1" minW="0" truncate>
            {cap(a.decisionClass)}
          </Text>
          <Text color="fg.subtle" flexShrink={0}>
            {clock(a.answeredAt, answered.timeZone)}
          </Text>
        </Flex>
      ))}
    </Flex>
  );
}

/** Read-only: opening an item does not answer it. Answering happens on GitHub; nothing here posts. */
export function NeedsYouPage({ state, item, thread, onRetry }: { state: UiState; item: ItemRef | null; thread: Feed<ThreadDetail>; onRetry: () => void }) {
  const queue = state.needsYou;
  if (queue.length === 0) {
    return (
      <Page>
        <PageHeadline sub="When a Thread needs a decision only you can make, it shows up here.">Nothing needs you.</PageHeadline>
        <AnsweredToday answered={state.answeredToday} />
      </Page>
    );
  }
  const selected = item === null ? queue[0]! : (queue.find((i) => same(i, item)) ?? null);
  const next = nextItem(queue, selected);
  return (
    <Page pb="0">
      <Flex align="flex-end" justify="space-between" gap="4" wrap="wrap">
        <PageHeadline sub="Opening one does not answer it. You answer on GitHub, and the factory picks it up within a minute.">
          <Owed>{queue.length === 1 ? "1 decision" : `${queue.length} decisions`}</Owed>, oldest first.
        </PageHeadline>
        {next && selected ? (
          <Flex align="center" gap="4" pb="6" flexShrink={0}>
            <Text textStyle="meta" color="fg.muted">
              {queue.indexOf(selected) + 1} of {queue.length}
            </Text>
            <LinkButton href={itemHash({ repo: next.repo, issue: next.issueNumber })}>Next</LinkButton>
          </Flex>
        ) : null}
      </Flex>
      <Flex direction={{ base: "column", lg: "row" }} flex="1" borderTopWidth="1px" borderTopColor="border" mx={{ base: "-6", md: "-56px" }}>
        <Flex as="ul" listStyleType="none" direction="column" w={{ lg: "400px" }} flexShrink={0} borderRightWidth={{ lg: "1px" }} borderRightColor="border" aria-label="Queue (oldest first)" css={{ "& > li": { borderBottomWidth: "1px", borderBottomColor: "var(--chakra-colors-border)" } }}>
          {queue.map((i) => {
            const on = selected === i;
            return (
              <li key={`${i.repo}#${i.issueNumber}`}>
                <Link
                  href={itemHash({ repo: i.repo, issue: i.issueNumber })}
                  aria-current={on ? "true" : undefined}
                  display="flex"
                  flexDirection="column"
                  alignItems="stretch"
                  textAlign="left"
                  gap="1"
                  py="3.5"
                  pl={{ base: "6", md: "56px" }}
                  pr="6"
                  bg={on ? "bg.subtle" : "transparent"}
                  textDecoration="none"
                  _hover={{ textDecoration: "none", bg: "bg.subtle" }}
                >
                  <Flex justify="space-between" align="baseline" gap="3">
                    <Text textStyle="rowTitle" color="fg">
                      {i.title}
                    </Text>
                    <Text textStyle="figure" fontSize="15px" color={on ? "owner" : "fg.subtle"} flexShrink={0}>
                      {gap(state.generatedAt - i.since)}
                    </Text>
                  </Flex>
                  <Text textStyle="meta" color="fg.muted">
                    <Ref repo={i.repo} num={i.issueNumber} /> · {cap(i.decisionClass)} · {recommendationShort(i)}
                  </Text>
                </Link>
              </li>
            );
          })}
          <AnsweredToday answered={state.answeredToday} />
        </Flex>
        <Box flex="1" minW="0" px={{ base: "6", md: "10" }} py="7">
          {selected === null ? (
            <Box role="status">
              <Text textStyle="rowTitle">That item no longer needs you.</Text>
              <Link href="#/needs-you">Back to the queue</Link>
            </Box>
          ) : (
            <Detail item={selected} now={state.generatedAt} thread={thread} onRetry={onRetry} />
          )}
        </Box>
      </Flex>
    </Page>
  );
}

function Detail({ item: i, now, thread, onRetry }: { item: Item; now: number; thread: Feed<ThreadDetail>; onRetry: () => void }) {
  const d = thread.data !== null && thread.data.repo === i.repo && thread.data.issueNumber === i.issueNumber ? thread.data : null;
  return (
    <Flex direction="column" gap="7">
      <Flex direction="column" gap="3">
        <Text textStyle="meta" color="fg.muted">
          <Ref repo={i.repo} num={i.issueNumber} href={`https://github.com/${i.repo}/issues/${i.issueNumber}`} />
          {i.prNumber ? ` · PR #${i.prNumber}` : ""}
          {d?.recap.themeLabel ? ` · Theme: ${d.recap.themeLabel}` : ""}
        </Text>
        <Text as="h2" textStyle="title" color="fg">
          {i.title}
        </Text>
        <Text textStyle="meta" color="fg.muted">
          <Box as="span" color="owner">
            {cap(i.decisionClass)}
          </Box>
          {" · "}Waiting {gap(now - i.since)} · <Text as="span" textStyle="ref">{i.code}</Text>
        </Text>
      </Flex>
      <Section gap="2">
        <Text textStyle="label" color="fg">
          {i.threadRecommendation ? "The factory recommends, for this Thread" : "The factory recommends"}
        </Text>
        <Text textStyle="headlineSub" color="fg" maxW="68ch">
          <Ticked>{i.threadRecommendation ? i.threadRecommendation.headline : i.recommendation}</Ticked>
        </Text>
        <Text textStyle="body13" color="fg.muted">
          {i.threadRecommendation ? i.threadRecommendation.reason : i.reason}
        </Text>
      </Section>
      {d === null ? (
        thread.error ? (
          <Box role="alert" borderTopWidth="1px" borderTopColor="owner" py="2.5" color="owner">
            <Text textStyle="body13">Recap and blockers could not be loaded ({thread.error}).</Text>
            <Link as="button" onClick={onRetry} textStyle="body13">
              Retry
            </Link>
          </Box>
        ) : (
          <Text textStyle="body13" color="fg.muted">
            Loading recap...
          </Text>
        )
      ) : (
        <Flex direction={{ base: "column", xl: "row" }} gap="56px">
          <Section flex="1" minW="0" gap="2">
            <Text textStyle="label" color="fg">
              Latest Recap
            </Text>
            <Facts
              rows={[
                ["Head commit", d.recap.headSha ?? NONE("none")],
                ["Attempts", d.recap.attempts],
                ["Implementer", d.recap.implementers.join(", ") || NONE("none")],
                ["Reviews", d.recap.reviews.map((r) => `${r.vendor} ${r.verdict}`).join(" · ") || NONE("none on this head")],
                [
                  "Gate",
                  d.gate.length === 0 ? (
                    NONE("not recorded")
                  ) : (
                    <>
                      {d.gate.map((g, k) => (
                        <Box as="span" display="block" key={k}>
                          {g.passed ? <Box as="span" color="passed">✓ Gate passed</Box> : g.label}
                        </Box>
                      ))}
                    </>
                  ),
                ],
                [
                  "Diff",
                  d.diff === null
                    ? NONE("not recorded")
                    : `${d.diff.nonTestLines} non-test lines in ${d.diff.files} files${d.diff.limits ? ` of ${d.diff.limits.maxNonTestLines} / ${d.diff.limits.maxFiles} allowed` : ""}`,
                ],
              ]}
            />
          </Section>
          <Section flex="1" minW="0">
            <Text textStyle="label" color="fg">
              Blockers
            </Text>
            {d.blockers.length === 0 ? (
              <Text textStyle="body13" color="fg.muted">
                None recorded in the Ledger. Live check state is on GitHub.
              </Text>
            ) : (
              <Flex as="ul" listStyleType="none" direction="column" gap="3.5">
                {d.blockers.map((b, k) => (
                  <Flex as="li" key={k} gap="3" align="flex-start">
                    <Box mt="7px">
                      <Dot tone={b.owner ? "owner" : "ink"} />
                    </Box>
                    <Flex direction="column" gap="0.5" minW="0">
                      <Text textStyle="rowTitle" color="fg">
                        {b.title}
                      </Text>
                      <Text textStyle="body13" color="fg.muted" wordBreak="break-word">
                        {b.detail}
                      </Text>
                    </Flex>
                  </Flex>
                ))}
              </Flex>
            )}
          </Section>
        </Flex>
      )}
      <Flex direction="column" gap="3" borderTopWidth="1px" borderTopColor="border" pt="5">
        <Flex gap="3" wrap="wrap" align="center">
          {SLUG.test(i.repo) ? (
            <LinkButton href={ghUrl(i)} primary external>
              Answer on GitHub
            </LinkButton>
          ) : null}
          <Box flex="1" minW="14rem" maxW="26rem">
            <CopyCommand command="/archangel retry" />
          </Box>
          <Link href={threadHash({ repo: i.repo, issue: i.issueNumber })} textStyle="body13" color="fg.muted">
            Open Thread timeline
          </Link>
        </Flex>
        <Text textStyle="meta" color="fg.muted">
          Archangel never replies for you: open the {i.prNumber ? "PR" : "issue"} and comment there.
        </Text>
      </Flex>
    </Flex>
  );
}

/** A recap value that is absent: grey, so the rows that hold something stand out. */
const NONE = (text: string) => (
  <Box as="span" color="fg.subtle">
    {text}
  </Box>
);

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <Flex direction="column" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
      {rows.map(([k, v]) => (
        <Flex key={k} gap="4" py="2.5">
          <Text textStyle="body13" color="fg.muted" w="110px" flexShrink={0}>
            {k}
          </Text>
          <Text textStyle="body13" color="fg" minW="0" wordBreak="break-word">
            {v}
          </Text>
        </Flex>
      ))}
    </Flex>
  );
}
