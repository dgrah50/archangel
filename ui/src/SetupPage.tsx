import { Box, Button, Code, Flex, Link, NativeSelect, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { PlanResult, ApplyResult as OnboardApply } from "../../src/core/ui-onboard.js";
import type { PreviewResult } from "../../src/core/ui-host-config.js";
import type { SettingsState } from "../../src/core/ui-settings.js";
import type { UiState, WorkflowsState } from "../../src/core/ui-state.js";
import type { EvalsState } from "../../src/core/eval-reports.js";
import type { DoctorCheck } from "../../src/core/doctor.js";
import type { Feed } from "./AppView";
import { age } from "./common";
import { EvalsSection } from "./EvalsPage";
import { FaultsSection, LadderList, ReadError, SmokeChecks, tokenOf, useLadder } from "./HealthPage";
import { HostErrorNotice, PreviewPanel } from "./HostConfigEditor";
import { applyHostConfig, applyOnboard, ghRead, loadHostConfig, planOnboard, previewHostConfig, type HostError } from "./host-config-client";
import { addProject } from "./host-edit";
import { CopyCommand, Dot, Page, PageHeadline, Section } from "./page";
import { ONBOARD_BRANCH, deriveSteps, groupSteps, isNotProtected, smokeIssueUrl, type OnboardingPr } from "./setup-steps";

interface GhRepo {
  nameWithOwner: string;
  defaultBranchRef: { name: string } | null;
  isArchived: boolean;
  viewerPermission: string;
}
type Gh<T> = { state: "idle" } | { state: "loading" } | { state: "ok"; value: T } | { state: "error"; error: HostError };
type Protection = { required_status_checks?: { contexts?: string[] } | null };

/** One gh read. Failures stay in the state so the panel can render them; nothing falls back to a default. */
function useGh<T>(what: "repos" | "user" | "pr", query: Record<string, string> | null): [Gh<T>, () => void] {
  const [gh, setGh] = useState<Gh<T>>({ state: "idle" });
  const key = query === null ? null : JSON.stringify(query);
  const load = useCallback(() => {
    if (key === null) return setGh({ state: "idle" });
    setGh({ state: "loading" });
    void ghRead<T>(what, JSON.parse(key) as Record<string, string>).then((r) => setGh(r.ok ? { state: "ok", value: r.value } : { state: "error", error: r.error }));
  }, [what, key]);
  useEffect(load, [load]);
  return [gh, load];
}

/** Branch protection of every listed repo's default branch (the per-repo check the doctor does not make). */
function useProtections(targets: Array<{ repo: string; branch: string }> | null): [Record<string, Gh<Protection>>, () => void] {
  const [all, setAll] = useState<Record<string, Gh<Protection>>>({});
  const [tick, setTick] = useState(0);
  const key = targets === null ? null : JSON.stringify(targets);
  useEffect(() => {
    if (key === null) return setAll({});
    const list = JSON.parse(key) as Array<{ repo: string; branch: string }>;
    let live = true;
    setAll(Object.fromEntries(list.map((t) => [t.repo, { state: "loading" } as Gh<Protection>])));
    for (const t of list) {
      void ghRead<Protection>("protection", { repo: t.repo, branch: t.branch }).then((r) => {
        if (live) setAll((a) => ({ ...a, [t.repo]: r.ok ? { state: "ok", value: r.value } : { state: "error", error: r.error } }));
      });
    }
    return () => { live = false; };
  }, [key, tick]);
  return [all, () => setTick((t) => t + 1)];
}

const short = (repo: string) => repo.split("/").pop() ?? repo;
const safeUrl = (u: unknown): string | null => (typeof u === "string" && u.startsWith("https://") ? u : null);
const outline = { variant: "outline", size: "sm", borderRadius: "12px" } as const;

function Mark({ done }: { done: boolean }) {
  return done ? (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-label="Done" role="img" style={{ flexShrink: 0, color: "var(--chakra-colors-fg)" }}>
      <path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <Flex role="img" aria-label="Needs attention" w="16px" h="16px" align="center" justify="center" flexShrink={0}><Dot tone="owner" /></Flex>
  );
}

/** A problem in plain words: title, an amber tag, the explanation, and commands to copy. */
function Problem({ title, tag, children }: { title: string; tag: string; children?: React.ReactNode }) {
  return (
    <Flex direction="column" gap="2.5" pt="3" borderTopWidth="1px" borderTopColor="owner" role="alert">
      <Flex gap="4" align="baseline">
        <Text textStyle="label" fontWeight="600" color="fg" flex="1">{title}</Text>
        <Text textStyle="meta" color="owner">{tag}</Text>
      </Flex>
      {children}
    </Flex>
  );
}
const Prose = ({ children }: { children: React.ReactNode }) => <Text textStyle="body13" color="fg.muted">{children}</Text>;
const Line = ({ children }: { children: React.ReactNode }) => <Text textStyle="meta" color="fg.muted">{children}</Text>;
const Sub = ({ children }: { children: React.ReactNode }) => <Text textStyle="label" color="fg" mt="2">{children}</Text>;

function GhError({ error, what, onRetry }: { error: HostError; what: string; onRetry: () => void }) {
  return (
    <>
      <HostErrorNotice error={error} onReload={onRetry} />
      <Line>Could not {what}. gh said the message above; nothing was assumed.</Line>
      <Button {...outline} size="xs" mt="2" onClick={onRetry}>Retry</Button>
    </>
  );
}

function PrCard({ repo, gh, onRetry }: { repo: string; gh: Gh<OnboardingPr>; onRetry: () => void }) {
  if (gh.state === "idle" || gh.state === "loading") return <Line>Looking for the onboarding PR...</Line>;
  if (gh.state === "error") return <GhError error={gh.error} what={`read the onboarding PR (${ONBOARD_BRANCH}) in ${repo}`} onRetry={onRetry} />;
  const pr = gh.value;
  const rows = pr.statusCheckRollup.map((c) => ({
    name: String(c.name ?? c.context ?? "check"),
    result: String(c.conclusion || c.state || c.status || "unknown"),
    url: safeUrl(c.detailsUrl ?? c.targetUrl),
  }));
  const bad = rows.filter((r) => /^(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED)$/.test(r.result));
  return (
    <Flex direction="column" gap="2" aria-label="Onboarding PR">
      <Text textStyle="label" color="fg">#{pr.number} {pr.title} <Text as="span" color={pr.state === "MERGED" ? "passed" : "fg.muted"}>{pr.state === "MERGED" ? "Merged" : pr.state === "OPEN" ? "Open" : "Closed"}</Text></Text>
      {rows.length === 0 ? <Line>No checks reported.</Line> : rows.map((r) => (
        <Line key={r.name}>
          <Text as="span" color={bad.includes(r) ? "owner" : r.result === "SUCCESS" ? "passed" : "fg.muted"} mr="2">{r.result.toLowerCase()}</Text>
          {r.url ? <Link href={r.url} target="_blank" rel="noreferrer noopener">{r.name}</Link> : r.name}
        </Line>
      ))}
      {bad.length > 0 ? <Text role="alert" textStyle="meta" color="owner">{bad.length === 1 ? "1 check is" : `${bad.length} checks are`} failing on this PR.</Text> : null}
      {pr.state === "CLOSED" ? <Text role="alert" textStyle="meta" color="owner">The PR was closed without merging. Plan and apply again above.</Text> : null}
      <Flex align="center" gap="3">
        <Link href={pr.url} target="_blank" rel="noreferrer noopener" textStyle="meta">Review and merge on GitHub</Link>
        <Line>This page never merges anything.</Line>
      </Flex>
    </Flex>
  );
}

/** Plan, then apply exactly that plan: apply is only reachable with a plan hash, and any failure drops the plan so it is made again. */
function OnboardPanel({ repo, onChanged }: { repo: string; onChanged: () => void }) {
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [applied, setApplied] = useState<OnboardApply | null>(null);
  const [error, setError] = useState<HostError | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPlan(null); setApplied(null); setError(null); }, [repo]);
  const runPlan = async () => {
    setBusy(true); setError(null); setApplied(null);
    const r = await planOnboard(repo);
    setBusy(false);
    if (r.ok) setPlan(r.value); else { setPlan(null); setError(r.error); }
  };
  const runApply = async () => {
    if (!plan) return;
    setBusy(true); setError(null);
    const r = await applyOnboard(repo, plan.planSha256);
    setBusy(false);
    setPlan(null); // a plan is single use
    if (r.ok) { setApplied(r.value); onChanged(); } else setError(r.error);
  };
  return (
    <Flex direction="column" gap="2">
      <Sub>Dry run, then apply</Sub>
      <Line>Apply creates labels, the {ONBOARD_BRANCH} branch and one PR with the owner's gh. It is safe to repeat.</Line>
      <Box><Button {...outline} onClick={() => void runPlan()} disabled={busy}>{plan ? "Plan again" : "Plan onboarding"}</Button></Box>
      {error ? <HostErrorNotice error={error} onReload={() => void runPlan()} /> : null}
      {plan ? (
        <Flex direction="column" gap="2" p="4" rounded="14px" bg="bg.subtle">
          <Prose>Default branch <Code>{plan.plan.defaultBranch}</Code>, stack {plan.plan.stack ?? "unknown"}.</Prose>
          {plan.plan.stack === null ? <Text role="alert" textStyle="meta" color="owner">Unknown stack: write .agents/archangel.json by hand (see templates/ in the Archangel repo).</Text> : null}
          <Line>Labels to create: {plan.plan.labelsToCreate.length === 0 ? "none" : plan.plan.labelsToCreate.join(", ")}</Line>
          {plan.plan.skipped.length > 0 ? <Line>Skipped (already there): {plan.plan.skipped.join(", ")}</Line> : null}
          {plan.plan.notes.map((n) => <Text key={n} textStyle="meta" color="owner">{n}</Text>)}
          {plan.plan.files.map((f) => (
            <Box key={f.path}>
              <Text textStyle="label" color="fg">Add {f.path}</Text>
              <Code as="pre" display="block" whiteSpace="pre-wrap" p="2" maxH="14rem" overflow="auto">{f.content}</Code>
            </Box>
          ))}
          <Box><Button size="sm" borderRadius="12px" onClick={() => void runApply()} disabled={busy}>Apply this plan</Button></Box>
        </Flex>
      ) : null}
      {applied ? <Box role="status">{applied.log.map((l) => <Line key={l}>{l}</Line>)}</Box> : null}
    </Flex>
  );
}

/** The host diff that adds the project (shadow mode on, Scouts off) goes through W2 with its own preview and confirm. */
function AddProject({ repo, defaultBranch, onChanged }: { repo: string; defaultBranch: string; onChanged: () => void }) {
  const [base, setBase] = useState<{ sha: string | null; text: string } | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<HostError | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const fail = (e: HostError) => { setError(e); setPreview(null); };
  const runPreview = async () => {
    setBusy(true); setError(null); setDone(null);
    const read = await loadHostConfig();
    if (!read.ok) { setBusy(false); return fail(read.error); }
    if (read.value.text === null) { setBusy(false); return fail({ kind: "validation", message: "There is no archangel.yaml yet. Create it under This machine's settings first." }); }
    let text: string;
    try { text = addProject(read.value.text, repo, defaultBranch); } catch (e) { setBusy(false); return fail({ kind: "validation", message: e instanceof Error ? e.message : String(e) }); }
    const r = await previewHostConfig(read.value.sha256, text);
    setBusy(false);
    if (r.ok) { setBase({ sha: read.value.sha256, text }); setPreview(r.value); } else fail(r.error);
  };
  const runApply = async () => {
    if (!base || !preview?.previewSha256) return;
    setBusy(true); setError(null);
    const r = await applyHostConfig(base.sha, base.text, preview.previewSha256, confirm);
    setBusy(false);
    if (!r.ok) return fail(r.error);
    setPreview(null);
    setDone(r.value.path);
    onChanged();
  };
  return (
    <Flex direction="column" gap="2">
      <Sub>Add {repo} to archangel.yaml</Sub>
      <Line>Shadow mode on, Scouts off. Applies after the daemon restarts.</Line>
      <Box><Button {...outline} onClick={() => void runPreview()} disabled={busy}>Preview the host change</Button></Box>
      {error ? <HostErrorNotice error={error} onReload={() => void runPreview()} /> : null}
      {preview ? <PreviewPanel preview={preview} confirm={confirm} onConfirm={setConfirm} onApply={() => void runApply()} busy={busy} blocked={null} /> : null}
      {done ? <Text role="status" textStyle="meta" color="fg.muted">Written to <Code>{done}</Code>. Restart the daemon to apply.</Text> : null}
    </Flex>
  );
}

function RepoPicker({ repo, gh, onRetry }: { repo: string | null; gh: Gh<GhRepo[]>; onRetry: () => void }) {
  if (gh.state === "error") return <GhError error={gh.error} what="list your repos" onRetry={onRetry} />;
  if (gh.state !== "ok") return <Line>Loading your repos...</Line>;
  return (
    <NativeSelect.Root size="sm" maxW="28rem">
      <NativeSelect.Field aria-label="Repo" value={repo ?? ""} onChange={(e) => { window.location.hash = e.target.value ? `#/setup/${e.target.value}` : "#/setup"; }}>
        <option value="">Choose a repo...</option>
        {gh.value.filter((r) => !r.isArchived).map((r) => <option key={r.nameWithOwner} value={r.nameWithOwner}>{r.nameWithOwner} ({r.viewerPermission.toLowerCase()})</option>)}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}

/** Is merging gated on the Gate? `null` while unread or unreadable (the table says so rather than guess). */
function gated(p: Gh<Protection> | undefined): "yes" | "no" | "unknown" | null {
  if (p === undefined || p.state === "idle" || p.state === "loading") return null;
  if (p.state === "error") return isNotProtected(p.error.message) ? "no" : "unknown";
  return (p.value.required_status_checks?.contexts ?? []).includes("Gate") ? "yes" : "no";
}

const PROTECTION_ROW = "Merging requires the Gate and CI";
const stripRepo = (name: string) => name.replace(/\s*\([^()]*\)$/, "");

function Cell({ status, title }: { status: "pass" | "bad" | "none" | "pending"; title?: string }) {
  if (status === "pass") return (
    <svg width="16" height="16" viewBox="0 0 16 16" role="img" aria-label="Passed" style={{ color: "var(--chakra-colors-fg)" }}>
      <path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  if (status === "bad") return <Flex role="img" aria-label={title ?? "Needs attention"} title={title} w="16px" h="16px" align="center" justify="center"><Dot tone="owner" /></Flex>;
  return <Text textStyle="meta" color="fg.subtle" title={status === "pending" ? "Not read yet" : "Not reported"}>{status === "pending" ? "..." : "-"}</Text>;
}

/** Rows are checks, columns are repos. */
function CheckTable({ repos, checks, protections }: { repos: string[]; checks: DoctorCheck[]; protections: Record<string, Gh<Protection>> | null }) {
  const rows: Array<{ id: string; label: string }> = [];
  for (const c of checks) {
    const id = c.id.split(":")[0]!;
    if (!rows.some((r) => r.id === id)) rows.push({ id, label: stripRepo(c.name) });
  }
  const cols = `minmax(0,1fr) repeat(${repos.length}, minmax(80px, 110px))`;
  const cell = (id: string, repo: string) => {
    const c = checks.find((x) => x.id === `${id}:${repo}`);
    return c === undefined ? <Cell status="none" /> : <Cell status={c.status === "pass" ? "pass" : "bad"} title={`${c.status}: ${c.detail}`} />;
  };
  return (
    <Box role="table" aria-label="Checks per repo">
      <Box role="row" display="grid" gridTemplateColumns={cols} gap="3" pb="2.5">
        <Text role="columnheader" textStyle="meta" color="fg.subtle">Check</Text>
        {repos.map((r) => <Text key={r} role="columnheader" textStyle="meta" color="fg.subtle" textAlign="center" title={r} truncate>{short(r)}</Text>)}
      </Box>
      {rows.map((r) => (
        <Box role="row" key={r.id} display="grid" gridTemplateColumns={cols} gap="3" alignItems="center" minH="44px" borderTopWidth="1px" borderTopColor="border">
          <Text role="rowheader" textStyle="body13" color="fg">{r.label}</Text>
          {repos.map((repo) => <Flex role="cell" key={repo} justify="center">{cell(r.id, repo)}</Flex>)}
        </Box>
      ))}
      {protections ? (
        <Box role="row" display="grid" gridTemplateColumns={cols} gap="3" alignItems="center" minH="44px" borderTopWidth="1px" borderTopColor="border" borderBottomWidth="1px" borderBottomColor="border">
          <Text role="rowheader" textStyle="body13" fontWeight="500" color="fg">{PROTECTION_ROW}</Text>
          {repos.map((repo) => {
            const g = gated(protections[repo]);
            return <Flex role="cell" key={repo} justify="center"><Cell status={g === null ? "pending" : g === "yes" ? "pass" : g === "no" ? "bad" : "none"} title={g === "no" ? "Not protected, or the Gate is not required" : undefined} /></Flex>;
          })}
        </Box>
      ) : null}
    </Box>
  );
}

export function SetupPage({ repo: routeRepo, state, settings, workflows, evals, now, onRetry }: { repo: string | null; state: UiState; settings: Feed<SettingsState>; workflows: Feed<WorkflowsState>; evals: Feed<EvalsState>; now: number; onRetry: () => void }) {
  const enabled = tokenOf() !== null;
  const host = settings.data?.host;
  const projects = host?.state === "ok" ? host.config.projects : [];
  // The repo the per-repo steps look at: the one in the URL, else the first repo in archangel.yaml.
  const repo = routeRepo ?? projects[0]?.repo ?? null;
  const [machine, runMachine] = useLadder("machine", false, true);
  const [repoLadder, runRepo] = useLadder("repo", false, enabled);
  const [repos, reloadRepos] = useGh<GhRepo[]>("repos", enabled ? {} : null);
  const routeBranch = repos.state === "ok" ? repos.value.find((r) => r.nameWithOwner === routeRepo)?.defaultBranchRef?.name : undefined;
  const [user, reloadUser] = useGh<{ id: number; login: string }>("user", enabled ? {} : null);
  const [pr, reloadPr] = useGh<OnboardingPr>("pr", enabled && repo ? { repo, branch: ONBOARD_BRANCH } : null);
  const targets = useMemo(() => {
    if (!enabled) return null;
    const t = projects.filter((p) => p.defaultBranch).map((p) => ({ repo: p.repo, branch: p.defaultBranch }));
    return t.length > 0 ? t : null;
  }, [enabled, projects]);
  const [protections, reloadProtections] = useProtections(targets);
  const [view, setView] = useState<number | null>(null);
  useEffect(() => setView(null), [routeRepo]);

  const checks = (l: typeof machine) => (l.state === "done" ? l.payload : null);
  const steps = deriveSteps({ machine: checks(machine), settings: settings.data, repo, pr: pr.state === "ok" ? pr.value : null, repoChecks: checks(repoLadder), workflows: workflows.data, state });
  const groups = groupSteps(steps);
  const open = view ?? (groups.find((g) => !g.done) ?? groups[groups.length - 1]!).n;
  const group = groups[open - 1]!;
  const project = repo ? projects.find((p) => p.repo.toLowerCase() === repo.toLowerCase()) : undefined;
  const reloadAll = () => { onRetry(); reloadPr(); runRepo(); reloadProtections(); };
  const checkAgain = () => { runMachine(); reloadAll(); };

  const todo = groups.filter((g) => !g.done).length;
  const first = host?.state !== "ok";
  const repoSlugs = projects.map((p) => p.repo);
  const repoChecks = repoLadder.state === "done" ? repoLadder.payload.checks : [];
  const badChecks = repoChecks.filter((c) => c.status !== "pass");
  const unprotected = projects.filter((p) => gated(protections[p.repo]) === "no");
  const checkedAt = repoLadder.state === "done" ? Math.max(0, state.generatedAt - repoLadder.payload.generatedAt) : null;
  const wf = repo ? workflows.data?.repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase()) : undefined;
  const feedErrors = [["Settings", settings], ["Pipeline", workflows]] as const;

  return (
    <Page>
      <Flex align="flex-end" justify="space-between" gap="6" wrap="wrap">
        <PageHeadline title="Setup and health">{first ? "not set up yet; work down the steps" : todo === 0 ? "set up and running" : `${todo} to look at`}</PageHeadline>
        <Flex align="center" gap="3" pb="3.5">
          {checkedAt !== null ? <Text textStyle="meta" color="fg.muted">Checked {checkedAt < 90_000 ? `${Math.round(checkedAt / 1000)} s` : age(checkedAt)} ago</Text> : null}
          <Button {...outline} onClick={checkAgain}>Check again</Button>
          <Button size="sm" borderRadius="12px" onClick={() => setView(3)}>Add a repo</Button>
        </Flex>
      </Flex>
      {!enabled ? <ReadError title="GitHub reads and writes are off for this dashboard (remote mode, or no token)."><Line>Start `archangel ui` without --allow-remote to use the repo steps.</Line></ReadError> : null}
      {feedErrors.map(([what, feed]) => feed.error === null ? null : (
        <ReadError key={what} title={`${what} ${feed.data ? "refresh failed; showing the last copy" : "unavailable"}.`}>
          <Line>{feed.error}</Line>
          <Button {...outline} size="xs" mt="2" onClick={onRetry}>Retry</Button>
        </ReadError>
      ))}
      <Flex gap="56px" direction={{ base: "column", lg: "row" }} flexShrink={0}>
        <Flex as="ol" direction="column" flex={{ lg: "0 0 38%" }} minW="0" listStyleType="none" aria-label="Setup steps" borderTopWidth="1px" borderTopColor="fg" borderBottomWidth="1px" borderBottomColor="border" alignSelf="flex-start" w="full" css={{ "& > li + li": { borderTopWidth: "1px", borderTopColor: "var(--chakra-colors-border)" } }}>
          {groups.map((g) => (
            <li key={g.n}>
              <Flex as="button" w="full" textAlign="left" gap="3.5" align="center" py="3.5" cursor="pointer" aria-current={open === g.n ? "step" : undefined} onClick={() => setView(g.n)}>
                <Mark done={g.done} />
                <Flex direction="column" gap="1px" flex="1" minW="0">
                  <Text textStyle="rowTitle" color="fg">{g.title}</Text>
                  <Text textStyle="meta" color={g.done ? "fg.muted" : "owner"}>{g.sentence}</Text>
                </Flex>
                {open === g.n ? <Text color="fg.muted" aria-hidden>›</Text> : null}
              </Flex>
            </li>
          ))}
        </Flex>
        <Section flex="1" minW="0" gap="4" aria-label={group.title}>
          <Flex direction="column" gap="1">
            <Text as="h2" textStyle="title" color="fg">{group.title}</Text>
            <Text textStyle="body13" color="fg.muted">{group.sentence}</Text>
          </Flex>

          {open === 1 ? (
            <>
              <LadderList ladder={machine} label="This machine" />
              <SmokeChecks />
            </>
          ) : null}

          {open === 2 ? (
            <Flex direction="column" gap="2">
              {host === undefined ? <Line>Loading archangel.yaml...</Line> : host.state === "ok" ? (
                <Prose>archangel.yaml is valid: owner id {host.config.ownerUserId}, {host.config.projects.length} {host.config.projects.length === 1 ? "project" : "projects"}.</Prose>
              ) : (
                <Problem title={host.state === "missing" ? "There is no archangel.yaml." : `archangel.yaml is ${host.state}.`} tag="Needs you"><Prose>{host.error}</Prose></Problem>
              )}
              {user.state === "error" ? <GhError error={user.error} what="read your GitHub user id" onRetry={reloadUser} /> : user.state === "ok" ? (
                <Line>Your GitHub user is {user.value.login} (id <Code>{user.value.id}</Code>).{host?.state === "ok" && host.config.ownerUserId !== user.value.id ? " This does not match ownerUserId in archangel.yaml." : ""}</Line>
              ) : null}
              {host?.state === "ok" && user.state === "ok" && host.config.ownerUserId !== user.value.id ? <Text role="alert" textStyle="meta" color="owner">ownerUserId differs from your GitHub id: issues you author will not count as owner-authored.</Text> : null}
              <Box><Button asChild {...outline}><a href="#/settings">Open Settings to {host?.state === "ok" ? "edit" : "create"} archangel.yaml</a></Button></Box>
            </Flex>
          ) : null}

          {open === 3 ? (
            <Flex direction="column" gap="4">
              <RepoPicker repo={routeRepo} gh={repos} onRetry={reloadRepos} />
              {routeRepo ? <><OnboardPanel repo={routeRepo} onChanged={reloadAll} />{project === undefined && host?.state === "ok" && routeBranch ? <AddProject repo={routeRepo} defaultBranch={routeBranch} onChanged={reloadAll} /> : null}</> : null}
              {repo ? <PrCard repo={repo} gh={pr} onRetry={reloadPr} /> : <Line>Choose a repo to see its setup PR.</Line>}
            </Flex>
          ) : null}

          {open === 4 ? (
            <>
              {unprotected.map((p) => (
                <Problem key={p.repo} title={`${short(p.repo)} does not require the Gate before merging`} tag="Works, but not protected">
                  <Prose>Branch protection on <Code>{p.defaultBranch}</Code> is not set, or does not list the Gate as a required check. The factory still waits for the Gate, but nothing stops a merge without it. Archangel does not change branch protection for you. See what it is now:</Prose>
                  <CopyCommand command={`gh api repos/${p.repo}/branches/${p.defaultBranch}/protection`} />
                  <Prose>Require the Gate, plus your CI job in contexts, before merges. Run this once:</Prose>
                  <CopyCommand command={`gh api -X PUT repos/${p.repo}/branches/${p.defaultBranch}/protection -F required_status_checks[strict]=true -f 'required_status_checks[contexts][]=Gate' -F enforce_admins=false -F required_pull_request_reviews=null -F restrictions=null`} />
                </Problem>
              ))}
              {projects.filter((p) => !p.defaultBranch).map((p) => <Problem key={p.repo} title={`${short(p.repo)}: branch protection was not read`} tag="Needs you"><Prose>The default branch is unknown.</Prose></Problem>)}
              {projects.map((p) => {
                const g = protections[p.repo];
                return g?.state === "error" && !isNotProtected(g.error.message) ? <GhError key={p.repo} error={g.error} what={`read branch protection for ${p.repo}`} onRetry={reloadProtections} /> : null;
              })}
              {badChecks.map((c) => (
                <Problem key={c.id} title={c.name} tag={c.status === "warn" ? "Warning" : "Failing"}>
                  <Prose>{c.detail}</Prose>
                  {c.remediation ? <Prose>{c.remediation}</Prose> : null}
                  {c.id.startsWith("gate_pin:") ? <CopyCommand command={`archangel gate-bump --repo ${c.id.slice("gate_pin:".length)}`} /> : null}
                </Problem>
              ))}
              {repoLadder.state === "done" || !enabled ? null : <LadderList ladder={repoLadder} label="GitHub wiring" />}
              {!enabled ? <Line>Needs the local dashboard.</Line> : repoSlugs.length === 0 ? <Line>No repos are in archangel.yaml yet, so there is nothing to check.</Line> : (
                <CheckTable repos={repoSlugs} checks={repoChecks} protections={targets ? protections : null} />
              )}
              <Line><Link href="https://github.com/settings/installations" target="_blank" rel="noreferrer noopener">Install the Archangel GitHub App on a repo</Link>. Pin drift: run <Code>archangel gate-bump</Code>.</Line>
            </>
          ) : null}

          {open === 5 ? (
            <Flex direction="column" gap="3">
              {settings.data?.status.restartPending ? <Problem title="A saved change is waiting for a restart" tag="Needs you"><Prose>The daemon has not loaded the file on disk. Archangel never restarts the daemon for you; run this in a terminal:</Prose><CopyCommand command="archangel daemon restart" /></Problem> : null}
              {settings.data && !settings.data.status.reported ? <Problem title="No daemon has reported its loaded config yet" tag="Needs you"><Prose>Start or restart the daemon.</Prose></Problem> : null}
              {state.daemonHeartbeatAt === null ? <Problem title="Daemon offline" tag="Needs you"><Prose>No daemon lock is held. Start it:</Prose><CopyCommand command="archangel start" /></Problem> : null}
              {repo ? (
                wf === undefined ? <Line>The daemon has no cached workflow for <Code>{repo}</Code> yet.</Line>
                  : wf.status === "ok" ? <Line>The workflow for <Code>{repo}</Code> is ok (<Link href="#/pipeline">open the Pipeline</Link>).</Line>
                  : <Problem title={`Halted: the workflow for ${repo} is ${wf.status}`} tag="Needs you">{wf.error ? <Prose>{wf.error}</Prose> : null}</Problem>
              ) : <Line>Add a repo first.</Line>}
            </Flex>
          ) : null}

          {open === 6 ? (
            repo ? (
              <Flex direction="column" gap="2">
                <Line>Checking <Code>{repo}</Code>. Pick another repo under Repos added.</Line>
                <Box><Button asChild {...outline}><a href={smokeIssueUrl(repo)} target="_blank" rel="noreferrer noopener">Open a smoke issue on GitHub</a></Button></Box>
                <Line>Prefilled and labelled ready-for-agent; submit it yourself so intake sees an owner-authored issue.</Line>
                <Sub>Or dry-run a Scout</Sub>
                <CopyCommand command={`archangel scout run bug-hunt --repo ${repo} --dry-run`} />
                <Line>Progress appears on the <Link href="#/threads">Threads</Link> page.</Line>
                {steps[7]!.done && project ? (
                  <>
                    <Sub>You're set up</Sub>
                    <Prose>{repo}: landing is {project.shadowMode ? "shadow (nothing lands on its own)" : "live"}; up to {project.maxConcurrentThreads} Threads at once and {project.maxAutoMergesPerDay} auto-merges per day; Scouts {project.scouts.enabled ? "on" : "off"}. Telegram notifications: {settings.data?.env.find((e) => e.name === "ARCHANGEL_TELEGRAM_BOT_TOKEN")?.set ? "configured" : "not configured"}.</Prose>
                    <Link href="#/settings" textStyle="meta">Enable Scouts (This machine, Projects)</Link>
                    <Link href="#/settings/repo" textStyle="meta">Let bugfixes land on their own (Repo, Landing: opens a PR)</Link>
                    <Link href="#/settings" textStyle="meta">Connect Telegram (Settings, Environment)</Link>
                  </>
                ) : <Line>Finish the earlier steps: {steps.filter((s) => !s.done && s.n < 8).map((s) => s.title).join(", ") || "none"}.</Line>}
              </Flex>
            ) : <Line>Add a repo first.</Line>
          ) : null}
        </Section>
      </Flex>
      <Flex direction="column" gap="10" mt="12">
        <FaultsSection faults={state.faults} now={now} />
        <EvalsSection evals={evals} now={now} onRetry={onRetry} />
      </Flex>
      <Text textStyle="meta" color="fg.muted" mt="10" maxW="420px">
        Checks that log in to a model provider only run when you press Run login checks, never in the background.
      </Text>
    </Page>
  );
}
