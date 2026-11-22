import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { useState, type ReactNode } from "react";
import type { PipelineRepo, PipelineStage, WorkflowsState } from "../../src/core/ui-state.js";
import type { SettingsState } from "../../src/core/ui-settings.js";
import type { Workflow } from "../../src/core/workflow.js";
import { Page, PageHeadline } from "./page";
import { DraftPanel, StageEditor, useDraft, type Draft } from "./WorkflowEditor";

// Everything here is rendered as React text children. Values originate in a repo's workflow file (untrusted) and are never HTML.

type EditableStage = "gate" | "review" | "landing" | "scouts";
const OWNER = { policy: "Repo policy, changed by PR", builtIn: "Built in, cannot change", machine: "Set on this machine", review: "Built in, order set on this machine" };
const APPLIES: Record<EditableStage, string> = { gate: "Applies to PRs opened after you merge", review: "Applies to the next review", landing: "Applies to the next landing", scouts: "Applies at the next Scout run" };
const short = (repo: string) => repo.split("/").pop() ?? repo;
const SCHEDULE = { daily: "daily", weekly: "once a week", manual: "when you run it" } as const;

const Mono = ({ children }: { children: ReactNode }) => (
  <Text as="span" textStyle="command" fontSize="14px">
    {children}
  </Text>
);

function Halted({ r }: { r: PipelineRepo }) {
  if (r.status === "ok") return null;
  const text =
    r.status === "missing"
      ? "Workflow file missing: this repo is halted (no intake, Scouts or autonomous landing) until .agents/archangel.json is on main."
      : r.status === "invalid"
        ? "Workflow file invalid: this repo is halted until it is fixed. Nothing falls back to another policy."
        : r.status === "unreadable"
          ? "The cached workflow is unreadable; the daemon will rewrite it on its next tick."
          : "Not resolved yet: the daemon has not read this repo's workflow.";
  return (
    <Box role="alert" borderTopWidth="1px" borderColor="fg" py="3" mb="4">
      <Text textStyle="body13" color="owner">
        {r.status === "unresolved" ? "Waiting for the daemon. " : "Halted. "}
        {text}
      </Text>
      {r.error ? (
        <Text textStyle="meta" color="fg.muted" mt="1">
          {r.error}
        </Text>
      ) : null}
    </Box>
  );
}

const item = (st: PipelineStage | undefined, label: string) => st?.items.find((i) => i.label === label)?.value;

function sentence(id: string, r: PipelineRepo, settings: SettingsState | null, draft: Workflow | undefined): ReactNode {
  const stage = r.stages.find((s) => s.id === id);
  const host = settings?.host.state === "ok" ? settings.host.config : null;
  switch (id) {
    case "intake":
      return (
        <>
          Only issues you wrote and labelled <Mono>ready-for-agent</Mono> are picked up.
        </>
      );
    case "build": {
      if (!host) return "Host settings are not loaded, so the build order is not shown.";
      const chain = host.chains.implement.map((e) => `${e.provider}${e.model ? ` ${e.model}` : ""}`);
      return `${chain[0]} goes first${chain.length > 1 ? `, ${chain.slice(1).join(", then ")} if it is cooling down` : ""}. Up to ${host.maxImplementAttemptsPerThread} attempts per Thread.`;
    }
    case "gate":
      return draft ? `A fix passes only with a new test that fails on main and passes on the branch, within ${draft.gate.maxNonTestLines} changed lines and ${draft.gate.maxFiles} files.` : "The Gate is unavailable until the workflow file is fixed.";
    case "review":
      return `Two reviewers from vendors that did not write the fix.${host ? ` Order on this machine: ${host.reviewerChain.map((e) => e.provider).join(", ")}.` : ""}${draft?.review.rubric ? " The repo adds its own rubric." : ""}`;
    case "landing": {
      const bugfix = item(stage, "bugfix");
      if (!bugfix) return "Landing is unavailable until the workflow file is fixed.";
      return `Bug fixes ${bugfix === "autonomous" ? `merge on their own, up to ${item(stage, "merges/day")} a day` : "wait for you"}. Features always wait for you.`;
    }
    default: {
      if (!draft) return "Scouts are unavailable until the workflow file is fixed.";
      if (draft.scouts.length === 0) return "No Scouts are declared.";
      return draft.scouts.map((s) => (s.kind === "bug" ? `${s.name} looks ${s.schedule === "manual" ? "when you run it" : s.schedule} and files up to ${s.maxProposals} bug${s.maxProposals === 1 ? "" : "s"}.` : `${s.name} pitches ${SCHEDULE[s.schedule]}.`)).join(" ");
    }
  }
}

const ROWS: Array<{ id: string; title: string; owner: string; edit?: EditableStage }> = [
  { id: "intake", title: "Intake", owner: OWNER.builtIn },
  { id: "build", title: "Build", owner: OWNER.machine },
  { id: "gate", title: "Gate", owner: OWNER.policy, edit: "gate" },
  { id: "review", title: "Review", owner: OWNER.review, edit: "review" },
  { id: "landing", title: "Landing", owner: OWNER.policy, edit: "landing" },
  { id: "scouts", title: "Scouts", owner: OWNER.policy, edit: "scouts" },
];

function RepoLine({ r, settings, d }: { r: PipelineRepo; settings: SettingsState | null; d: Draft | null }) {
  const [open, setOpen] = useState<EditableStage | null>(null);
  const builtIn = settings?.kernel.universalProtected ?? [];
  return (
    <Box borderTopWidth="1px" borderTopColor="fg" css={{ "& > * + *": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
      {ROWS.map((row) => {
        const stage = r.stages.find((s) => s.id === row.id);
        const editable = row.edit !== undefined && d !== null;
        const isOpen = editable && open === row.edit;
        return (
          <Box key={row.id} py="5" aria-label={`stage ${row.title}`}>
            <Flex gap="4" align="baseline">
              <Text textStyle="rowTitle" fontSize="17px" w="128px" flexShrink={0}>
                {row.title}
              </Text>
              <Box flex="1" minW="0">
                <Text textStyle="body13" fontSize="15.5px" lineHeight="26px" color="fg">
                  {sentence(row.id, r, settings, d?.pinned.initial)}
                </Text>
                {stage?.clamps.map((c) => (
                  <Text key={c} textStyle="meta" color="fg.muted">
                    {c}
                  </Text>
                ))}
              </Box>
              <Flex direction="column" align="flex-end" flexShrink={0} maxW="260px" textAlign="right">
                <Text textStyle="body13" color="fg.subtle">
                  {isOpen && row.edit ? APPLIES[row.edit] : row.owner}
                </Text>
                {editable ? (
                  <Button variant="plain" size="xs" h="auto" minW="0" p="0" fontWeight="400" color="fg.muted" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : row.edit!)}>
                    {isOpen ? "Close" : "Edit"}
                  </Button>
                ) : null}
              </Flex>
            </Flex>
            {isOpen && row.edit && d ? (
              <Box ml="144px">
                <StageEditor stage={row.edit} d={d} builtIn={builtIn} />
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

/** One repo's line. Keyed by repo so each repo keeps its own draft; the draft hook only mounts when the workflow resolved. */
function RepoView({ r, settings }: { r: PipelineRepo; settings: SettingsState | null }) {
  const poll = settings?.host.state === "ok" ? Math.round(settings.host.config.pollIntervalMs / 1000) : null;
  return r.draft && r.fileSha256 ? <Editing r={r} draft={r.draft} sha={r.fileSha256} settings={settings} poll={poll} /> : (
    <>
      <Halted r={r} />
      <RepoLine r={r} settings={settings} d={null} />
    </>
  );
}

function Editing({ r, draft, sha, settings, poll }: { r: PipelineRepo; draft: Workflow; sha: string; settings: SettingsState | null; poll: number | null }) {
  const d = useDraft(r.repo, draft, sha);
  return (
    <Flex direction={{ base: "column", lg: "row" }} gap="40px" align="flex-start">
      <Box flex="1" minW="0" w="full">
        <RepoLine r={r} settings={settings} d={d} />
      </Box>
      <Box w={{ base: "full", lg: "360px" }} flexShrink={0}>
        <DraftPanel d={d} pollSeconds={poll} />
      </Box>
    </Flex>
  );
}

export function Pipeline({ data, settings }: { data: WorkflowsState; settings: SettingsState | null }) {
  const [picked, setPicked] = useState<string | null>(null);
  const repo = data.repos.find((r) => r.repo === picked) ?? data.repos[0];
  if (!repo) {
    return (
      <Page>
        <PageHeadline sub="Add a repo in Setup and health, and its line shows up here.">No repo has a line yet.</PageHeadline>
      </Page>
    );
  }
  return (
    <Page>
      <Flex justify="space-between" align="flex-start" gap="6">
        <PageHeadline sub="The rules live in the repo. Edits here open a PR that only you can merge.">{`How ${short(repo.repo)}'s line is set up.`}</PageHeadline>
        <Flex gap="1" p="4px" rounded="12px" bg="bg.muted" mt="10px" flexShrink={0} role="tablist" aria-label="Repo">
          {data.repos.map((r) => (
            <Button key={r.repo} role="tab" aria-selected={r.repo === repo.repo} size="sm" h="36px" px="16px" borderRadius="10px" variant="plain" fontWeight={r.repo === repo.repo ? "500" : "400"} {...(r.repo === repo.repo ? { bg: "bg", color: "fg" } : { color: "fg.muted" })} onClick={() => setPicked(r.repo)}>
              {short(r.repo)}
            </Button>
          ))}
        </Flex>
      </Flex>
      <RepoView key={repo.repo} r={repo} settings={settings} />
    </Page>
  );
}
