import { Badge, Box, Button, Code, Flex, Heading, Link, NativeSelect, Stack, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useState } from "react";
import type { PlanResult, ApplyResult as OnboardApply } from "../../src/core/ui-onboard.js";
import type { PreviewResult } from "../../src/core/ui-host-config.js";
import type { SettingsState } from "../../src/core/ui-settings.js";
import type { UiState, WorkflowsState } from "../../src/core/ui-state.js";
import type { Feed } from "./AppView";
import { CopyCommand, LadderView, tokenOf, useLadder, type Ladder } from "./HealthPage";
import { HostErrorNotice, PreviewPanel } from "./HostConfigEditor";
import { applyHostConfig, applyOnboard, ghRead, loadHostConfig, planOnboard, previewHostConfig, type HostError } from "./host-config-client";
import { addProject } from "./host-edit";
import { ONBOARD_BRANCH, currentStep, deriveSteps, isNotProtected, smokeIssueUrl, type OnboardingPr } from "./setup-steps";

interface GhRepo {
  nameWithOwner: string;
  defaultBranchRef: { name: string } | null;
  isArchived: boolean;
  viewerPermission: string;
}
type Gh<T> = { state: "idle" } | { state: "loading" } | { state: "ok"; value: T } | { state: "error"; error: HostError };

/** One gh read. Failures stay in the state so the panel can render them; nothing falls back to a default. */
function useGh<T>(what: "repos" | "user" | "pr" | "protection", query: Record<string, string> | null): [Gh<T>, () => void] {
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

function Alert({ tone = "red", title, children }: { tone?: "red" | "orange"; title: string; children?: React.ReactNode }) {
  return (
    <Box role="alert" borderWidth="1px" borderColor={`${tone}.solid`} rounded="md" p="3" mt="3" textStyle="sm">
      <Text fontWeight="medium">{title}</Text>
      {children}
    </Box>
  );
}

function GhError({ error, what, onRetry }: { error: HostError; what: string; onRetry: () => void }) {
  return (
    <>
      <HostErrorNotice error={error} onReload={onRetry} />
      <Text textStyle="sm" color="fg.muted" mt="1">Could not {what}. gh said the message above; nothing was assumed.</Text>
      <Button size="xs" mt="2" onClick={onRetry}>Retry</Button>
    </>
  );
}

function Cmd({ text }: { text: string }) {
  return (
    <Flex align="center" gap="2" mt="2" wrap="wrap">
      <Code>{text}</Code>
      <CopyCommand text={text} />
    </Flex>
  );
}

const safeUrl = (u: unknown): string | null => (typeof u === "string" && u.startsWith("https://") ? u : null);

function PrCard({ repo, gh, onRetry }: { repo: string; gh: Gh<OnboardingPr>; onRetry: () => void }) {
  if (gh.state === "idle" || gh.state === "loading") return <Text color="fg.muted" mt="3">Looking for the onboarding PR...</Text>;
  if (gh.state === "error") return <GhError error={gh.error} what={`read the onboarding PR (${ONBOARD_BRANCH}) in ${repo}`} onRetry={onRetry} />;
  const pr = gh.value;
  const rows = pr.statusCheckRollup.map((c) => ({
    name: String(c.name ?? c.context ?? "check"),
    result: String(c.conclusion || c.state || c.status || "unknown"),
    url: safeUrl(c.detailsUrl ?? c.targetUrl),
  }));
  const bad = rows.filter((r) => /^(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED)$/.test(r.result));
  return (
    <Box borderWidth="1px" rounded="md" p="3" mt="3" aria-label="Onboarding PR">
      <Flex gap="2" align="center" wrap="wrap">
        <Badge colorPalette={pr.state === "MERGED" ? "green" : pr.state === "OPEN" ? "blue" : "gray"}>{pr.state.toLowerCase()}</Badge>
        <Text fontWeight="medium">#{pr.number} {pr.title}</Text>
      </Flex>
      {rows.length === 0 ? <Text textStyle="sm" color="fg.muted" mt="2">No checks reported.</Text> : (
        <Stack as="ul" listStyleType="none" gap="1" mt="2">
          {rows.map((r) => (
            <Text as="li" key={r.name} textStyle="sm">
              <Badge colorPalette={bad.includes(r) ? "red" : r.result === "SUCCESS" ? "green" : "gray"} mr="2">{r.result.toLowerCase()}</Badge>
              {r.url ? <Link href={r.url} target="_blank" rel="noreferrer noopener">{r.name}</Link> : r.name}
            </Text>
          ))}
        </Stack>
      )}
      {bad.length > 0 ? <Alert title={`${bad.length} check(s) are failing on this PR.`} /> : null}
      {pr.state === "CLOSED" ? <Alert tone="orange" title="The PR was closed without merging. Plan and apply again in step 3." /> : null}
      <Flex mt="3"><Link href={pr.url} target="_blank" rel="noreferrer noopener">Review and merge on GitHub</Link></Flex>
      <Text textStyle="xs" color="fg.muted">This page never merges anything.</Text>
    </Box>
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
    <Box mt="4">
      <Heading size="sm">Dry run, then apply</Heading>
      <Text textStyle="sm" color="fg.muted">Apply creates labels, the {ONBOARD_BRANCH} branch and one PR with the owner's gh. It is safe to repeat.</Text>
      <Button size="sm" mt="2" onClick={() => void runPlan()} disabled={busy}>{plan ? "Plan again" : "Plan onboarding"}</Button>
      {error ? <HostErrorNotice error={error} onReload={() => void runPlan()} /> : null}
      {plan ? (
        <Box mt="3" borderWidth="1px" rounded="md" p="3">
          <Text textStyle="sm">Default branch <Code>{plan.plan.defaultBranch}</Code>, stack {plan.plan.stack ?? "unknown"}.</Text>
          {plan.plan.stack === null ? <Alert tone="orange" title="Unknown stack: write .agents/archangel.json by hand (see templates/ in the Archangel repo)." /> : null}
          <Text textStyle="sm" mt="2">Labels to create: {plan.plan.labelsToCreate.length === 0 ? "none" : plan.plan.labelsToCreate.join(", ")}</Text>
          {plan.plan.skipped.length > 0 ? <Text textStyle="sm">Skipped (already there): {plan.plan.skipped.join(", ")}</Text> : null}
          {plan.plan.notes.map((n) => <Text key={n} textStyle="sm" color="orange.fg">{n}</Text>)}
          {plan.plan.files.map((f) => (
            <Box key={f.path} mt="2">
              <Text textStyle="sm" fontWeight="medium">Add {f.path}</Text>
              <Code as="pre" display="block" whiteSpace="pre-wrap" p="2" maxH="14rem" overflow="auto">{f.content}</Code>
            </Box>
          ))}
          <Button size="sm" mt="3" colorPalette="blue" onClick={() => void runApply()} disabled={busy}>Apply this plan</Button>
        </Box>
      ) : null}
      {applied ? (
        <Box role="status" borderWidth="1px" borderColor="green.solid" rounded="md" p="3" mt="3" textStyle="sm">
          {applied.log.map((l) => <Text key={l}>{l}</Text>)}
        </Box>
      ) : null}
    </Box>
  );
}

/** The host diff that adds the project (shadow mode on, Scouts off) goes through W2 with its own preview and confirm. */
function AddProject({ repo, onChanged }: { repo: string; onChanged: () => void }) {
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
    if (read.value.text === null) { setBusy(false); return fail({ kind: "validation", message: "There is no archangel.yaml yet. Create it in step 2 first." }); }
    let text: string;
    try { text = addProject(read.value.text, repo); } catch (e) { setBusy(false); return fail({ kind: "validation", message: e instanceof Error ? e.message : String(e) }); }
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
    <Box mt="4">
      <Heading size="sm">Add {repo} to archangel.yaml</Heading>
      <Text textStyle="sm" color="fg.muted">Shadow mode on, Scouts off. Applies after the daemon restarts.</Text>
      <Button size="sm" mt="2" onClick={() => void runPreview()} disabled={busy}>Preview the host change</Button>
      {error ? <HostErrorNotice error={error} onReload={() => void runPreview()} /> : null}
      {preview ? <PreviewPanel preview={preview} confirm={confirm} onConfirm={setConfirm} onApply={() => void runApply()} busy={busy} blocked={null} /> : null}
      {done ? <Box role="status" borderWidth="1px" borderColor="green.solid" rounded="md" p="3" mt="3" textStyle="sm">Written to <Code>{done}</Code>. Restart the daemon to apply.</Box> : null}
    </Box>
  );
}

function RepoPicker({ repo, gh, onRetry }: { repo: string | null; gh: Gh<GhRepo[]>; onRetry: () => void }) {
  if (gh.state === "error") return <GhError error={gh.error} what="list your repos" onRetry={onRetry} />;
  if (gh.state !== "ok") return <Text color="fg.muted">Loading your repos...</Text>;
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

function Protection({ repo, branch }: { repo: string; branch: string }) {
  const [gh, reload] = useGh<{ required_status_checks?: { contexts?: string[] } | null }>("protection", { repo, branch });
  if (gh.state === "idle" || gh.state === "loading") return <Text color="fg.muted" mt="3">Reading branch protection...</Text>;
  if (gh.state === "error") {
    if (isNotProtected(gh.error.message)) {
      return (
        <Alert tone="orange" title={`${branch} is not protected (usable, but partial).`}>
          <Text>Require the Gate check, plus your CI job, before merges. Add your CI job to contexts:</Text>
          <Cmd text={`gh api -X PUT repos/${repo}/branches/${branch}/protection -F required_status_checks[strict]=true -f 'required_status_checks[contexts][]=Gate' -F enforce_admins=false -F required_pull_request_reviews=null -F restrictions=null`} />
        </Alert>
      );
    }
    return <GhError error={gh.error} what="read branch protection" onRetry={reload} />;
  }
  const contexts = gh.value.required_status_checks?.contexts ?? [];
  return <Text textStyle="sm" mt="3"><Badge colorPalette={contexts.includes("Gate") ? "green" : "orange"} mr="2">protected</Badge>Required checks: {contexts.length === 0 ? "none" : contexts.join(", ")}.{contexts.includes("Gate") ? "" : " Gate is not required."}</Text>;
}

function FeedNotice({ feed, what, onRetry }: { feed: Feed<unknown>; what: string; onRetry: () => void }) {
  if (feed.error === null) return null;
  return (
    <Alert title={`${what} ${feed.data ? "refresh failed; showing the last copy" : "unavailable"}.`}>
      <Text>{feed.error}</Text>
      <Button size="xs" mt="2" onClick={onRetry}>Retry</Button>
    </Alert>
  );
}

export function SetupPage({ repo, state, settings, workflows, onRetry }: { repo: string | null; state: UiState; settings: Feed<SettingsState>; workflows: Feed<WorkflowsState>; onRetry: () => void }) {
  const enabled = tokenOf() !== null;
  const [machine, runMachine] = useLadder("machine", false, true);
  const [repoLadder, runRepo] = useLadder("repo", false, enabled && repo !== null);
  const [repos, reloadRepos] = useGh<GhRepo[]>("repos", enabled ? {} : null);
  const [user, reloadUser] = useGh<{ id: number; login: string }>("user", enabled ? {} : null);
  const [pr, reloadPr] = useGh<OnboardingPr>("pr", enabled && repo ? { repo, branch: ONBOARD_BRANCH } : null);
  const [view, setView] = useState<number | null>(null);
  useEffect(() => setView(null), [repo]);

  const checks = (l: Ladder) => (l.state === "done" ? l.payload : null);
  const steps = deriveSteps({ machine: checks(machine), settings: settings.data, repo, pr: pr.state === "ok" ? pr.value : null, repoChecks: checks(repoLadder), workflows: workflows.data, state });
  const open = view ?? currentStep(steps);
  const host = settings.data?.host;
  const project = host?.state === "ok" && repo ? host.config.projects.find((p) => p.repo.toLowerCase() === repo.toLowerCase()) : undefined;
  const reloadAll = () => { onRetry(); reloadPr(); runRepo(); };
  const repoRepoLadder: Ladder = repoLadder.state === "done" ? { state: "done", payload: { ...repoLadder.payload, checks: repoLadder.payload.checks.filter((c) => c.id.endsWith(`:${repo}`)) } } : repoLadder;
  const defaultBranch = project?.defaultBranch ?? (repos.state === "ok" ? repos.value.find((r) => r.nameWithOwner.toLowerCase() === repo?.toLowerCase())?.defaultBranchRef?.name : undefined);

  return (
    <Box maxW="64rem" mx="auto" p="6">
      <Heading size="xl">Setup</Heading>
      <Text color="fg.muted" textStyle="sm">Progress is read from this machine and GitHub each time, never stored: a reload or a CLI shortcut resumes here.</Text>
      {!enabled ? <Alert title="GitHub reads and writes are off for this dashboard (remote mode, or no token)."><Text>Start `archangel ui` without --allow-remote to use the repo steps.</Text></Alert> : null}
      <FeedNotice feed={settings} what="Settings" onRetry={onRetry} />
      <FeedNotice feed={workflows} what="Pipeline" onRetry={onRetry} />
      <Flex gap="6" mt="6" direction={{ base: "column", md: "row" }}>
        <Stack as="ol" listStyleType="none" gap="1" w={{ md: "15rem" }} flexShrink={0} aria-label="Setup steps">
          {steps.map((s) => (
            <Box as="li" key={s.n}>
              <Button variant={open === s.n ? "subtle" : "ghost"} size="sm" justifyContent="flex-start" w="full" aria-current={open === s.n ? "step" : undefined} onClick={() => setView(s.n)}>
                <Badge colorPalette={s.done ? "green" : "gray"}>{s.done ? "done" : s.n}</Badge>
                {s.title}
              </Button>
            </Box>
          ))}
        </Stack>
        <Box flex="1" minW="0" as="section" aria-label={`Step ${open}`}>
          <Heading size="md">{open}. {steps[open - 1]!.title}</Heading>
          <Text textStyle="sm" color="fg.muted">{steps[open - 1]!.detail}</Text>
          {open === 1 ? (
            <>
              <LadderView title="This machine" hint="Git, configuration, App key, CLIs, SQLite, Paseo, gh login. No network." ladder={machine} onRun={runMachine} runLabel="Recheck" />
              <Text textStyle="sm" color="fg.muted" mt="3">Subscription CLI login checks run only when you press the button on the <Link href="#/health">Health</Link> page.</Text>
            </>
          ) : null}
          {open === 2 ? (
            <Box mt="4">
              {host === undefined ? <Text color="fg.muted">Loading archangel.yaml...</Text> : host.state === "ok" ? (
                <Text>archangel.yaml is valid: owner id {host.config.ownerUserId}, {host.config.projects.length} project(s).</Text>
              ) : (
                <Alert title={host.state === "missing" ? "There is no archangel.yaml." : `archangel.yaml is ${host.state}.`}><Text>{host.error}</Text></Alert>
              )}
              {user.state === "error" ? <GhError error={user.error} what="read your GitHub user id" onRetry={reloadUser} /> : user.state === "ok" ? (
                <Text textStyle="sm" mt="2">Your GitHub user is {user.value.login} (id <Code>{user.value.id}</Code>).{host?.state === "ok" && host.config.ownerUserId !== user.value.id ? " This does not match ownerUserId in archangel.yaml." : ""}</Text>
              ) : null}
              {host?.state === "ok" && user.state === "ok" && host.config.ownerUserId !== user.value.id ? <Alert tone="orange" title="ownerUserId differs from your GitHub id: issues you author will not count as owner-authored." /> : null}
              <Flex mt="3"><Link href="#/settings">Open Settings to {host?.state === "ok" ? "edit" : "create"} archangel.yaml</Link></Flex>
            </Box>
          ) : null}
          {open === 3 ? (
            <Box mt="4">
              <RepoPicker repo={repo} gh={repos} onRetry={reloadRepos} />
              {repo ? <><OnboardPanel repo={repo} onChanged={reloadAll} />{project === undefined && host?.state === "ok" ? <AddProject repo={repo} onChanged={reloadAll} /> : null}</> : null}
              {repo && pr.state === "ok" ? <PrCard repo={repo} gh={pr} onRetry={reloadPr} /> : null}
            </Box>
          ) : null}
          {open === 4 ? (repo ? <PrCard repo={repo} gh={pr} onRetry={reloadPr} /> : <Text mt="4">Choose a repo in step 3.</Text>) : null}
          {open === 5 ? (
            repo ? (
              <>
                <LadderView title={`GitHub wiring for ${repo}`} hint="App permissions, Gate workflow and pin, labels. Calls the GitHub API." ladder={repoRepoLadder} onRun={runRepo} runLabel="Recheck" disabledReason={enabled ? undefined : "Needs the local dashboard."} />
                <Text textStyle="sm" mt="3"><Link href="https://github.com/settings/installations" target="_blank" rel="noreferrer noopener">Install the Archangel GitHub App on {repo}</Link>. Pin drift: run <Code>archangel gate-bump</Code>.</Text>
                {defaultBranch ? <Protection repo={repo} branch={defaultBranch} /> : <Alert tone="orange" title="The default branch is unknown, so branch protection was not read." />}
              </>
            ) : <Text mt="4">Choose a repo in step 3.</Text>
          ) : null}
          {open === 6 ? (
            <Box mt="4">
              {settings.data?.status.restartPending ? <><Alert tone="orange" title="Restart pending: the daemon has not loaded the file on disk." /><Cmd text="archangel daemon restart" /></> : null}
              {settings.data && !settings.data.status.reported ? <Alert tone="orange" title="No daemon has reported its loaded config yet. Start or restart the daemon." /> : null}
              {state.daemonHeartbeatAt === null ? <Alert title="Daemon offline: no daemon lock is held. Run `archangel start`." /> : null}
              {repo ? (() => {
                const wf = workflows.data?.repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase());
                return wf === undefined ? <Text mt="3">The daemon has no cached workflow for {repo} yet.</Text>
                  : wf.status === "ok" ? <Text mt="3">Workflow <Badge colorPalette="green">ok</Badge> (<Link href="#/pipeline">open the Pipeline</Link>).</Text>
                  : <Alert title={`Halted: the workflow for ${repo} is ${wf.status}.`}>{wf.error ? <Text>{wf.error}</Text> : null}</Alert>;
              })() : <Text mt="3">Choose a repo in step 3.</Text>}
            </Box>
          ) : null}
          {open === 7 ? (
            repo ? (
              <Box mt="4">
                <Link href={smokeIssueUrl(repo)} target="_blank" rel="noreferrer noopener">Open a smoke issue on GitHub</Link>
                <Text textStyle="sm" color="fg.muted">Prefilled and labelled ready-for-agent; submit it yourself so intake sees an owner-authored issue.</Text>
                <Text textStyle="sm" mt="3">Or dry-run a Scout:</Text>
                <Cmd text={`archangel scout run bug-hunt --repo ${repo} --dry-run`} />
                <Text textStyle="sm" mt="3">Progress appears on the <Link href="#/threads">Threads</Link> page.</Text>
              </Box>
            ) : <Text mt="4">Choose a repo in step 3.</Text>
          ) : null}
          {open === 8 ? (
            <Box mt="4">
              {steps[7]!.done && project ? (
                <>
                  <Alert tone="orange" title="You're set up." />
                  <Text textStyle="sm" mt="3">{repo}: landing is {project.shadowMode ? "shadow (nothing lands on its own)" : "live"}; up to {project.maxConcurrentThreads} Threads at once and {project.maxAutoMergesPerDay} auto-merges per day; Scouts {project.scouts.enabled ? "on" : "off"}.</Text>
                  <Text textStyle="sm">Telegram notifications: {settings.data?.env.find((e) => e.name === "ARCHANGEL_TELEGRAM_BOT_TOKEN")?.set ? "configured" : "not configured"}.</Text>
                  <Stack mt="3" gap="1">
                    <Link href="#/settings">Enable Scouts (This machine, Projects)</Link>
                    <Link href="#/settings/repo">Let bugfixes land on their own (Repo, Landing: opens a PR)</Link>
                    <Link href="#/settings">Connect Telegram (Settings, Environment)</Link>
                  </Stack>
                </>
              ) : <Text mt="4">Finish the earlier steps: {steps.filter((s) => !s.done && s.n < 8).map((s) => s.title).join(", ")}.</Text>}
            </Box>
          ) : null}
        </Box>
      </Flex>
    </Box>
  );
}
