import type { DoctorPayload } from "../../src/core/ui-doctor.js";
import type { SettingsState } from "../../src/core/ui-settings.js";
import type { UiState, WorkflowsState } from "../../src/core/ui-state.js";
import { DAEMON_OFFLINE_MS } from "./AppView";

/** Mirrors ONBOARD_BRANCH in src/core/onboard.ts (which cannot be imported into the browser: it pulls in node:path). */
export const ONBOARD_BRANCH = "chore/archangel-onboard";

export interface OnboardingPr {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  url: string;
  statusCheckRollup: Array<Record<string, unknown>>;
}

/** Everything the wizard looks at. A `null` is "not read yet or the read failed": that step is never reported done. */
interface SetupFacts {
  machine: DoctorPayload | null;
  settings: SettingsState | null;
  repo: string | null;
  pr: OnboardingPr | null;
  repoChecks: DoctorPayload | null;
  workflows: WorkflowsState | null;
  state: UiState | null;
}

export interface Step {
  n: number;
  title: string;
  done: boolean;
  detail: string;
}

const failing = (p: DoctorPayload | null, repo?: string) => (p?.checks ?? []).filter((c) => c.status === "fail" && (repo === undefined || c.id.endsWith(`:${repo}`)));

/**
 * Progress is derived from these facts and stored nowhere: a reload, a daemon restart, or doing a step by hand on the CLI all resume
 * correctly. Step 8 is done only when steps 1-7 are.
 */
export function deriveSteps(f: SetupFacts): Step[] {
  const same = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();
  const host = f.settings?.host;
  const project = host?.state === "ok" && f.repo ? host.config.projects.find((p) => same(p.repo, f.repo)) : undefined;
  const repoRows = (f.repoChecks?.checks ?? []).filter((c) => f.repo !== null && c.id.endsWith(`:${f.repo}`));
  const merged = f.pr?.state === "MERGED" || repoRows.some((c) => c.id === `gate_workflow:${f.repo}` && c.status === "pass");
  const wf = f.workflows?.repos.find((r) => same(r.repo, f.repo));
  const beat = f.state?.daemonHeartbeatAt ?? null;
  const live = f.state !== null && beat !== null && f.state.generatedAt - beat <= DAEMON_OFFLINE_MS;
  const hasActivity = f.state !== null && (Object.values(f.state.groups).some((g) => g.some((i) => same(i.repo, f.repo))) || f.state.scouts.some((s) => same(s.repo, f.repo)));
  const needRepo = "Choose a repo under Repos added.";
  const machineFails = failing(f.machine).length;
  const repoFails = failing(f.repoChecks, f.repo ?? undefined).length;

  const steps: Array<Omit<Step, "n">> = [
    { title: "Prerequisites", done: f.machine !== null && machineFails === 0, detail: f.machine === null ? "Machine checks have not completed." : machineFails === 0 ? "No machine check fails." : `${machineFails} machine check(s) fail.` },
    { title: "This machine", done: host?.state === "ok" && host.config.projects.length > 0, detail: host === undefined ? "archangel.yaml has not been read." : host.state === "ok" ? `archangel.yaml is valid with ${host.config.projects.length} project(s).` : `archangel.yaml is ${host.state}.` },
    { title: "Add a repo", done: project !== undefined && merged, detail: !f.repo ? needRepo : project === undefined ? `${f.repo} is not in archangel.yaml projects.` : merged ? "In projects, and the onboarding PR is merged (or the Gate workflow is on the default branch)." : "In projects, but onboarding is not merged." },
    { title: "Setup PR", done: f.repo !== null && merged, detail: !f.repo ? needRepo : merged ? "Merged." : f.pr ? `The onboarding PR is ${f.pr.state.toLowerCase()}.` : "No onboarding PR was found." },
    { title: "GitHub wiring", done: repoRows.length > 0 && repoFails === 0, detail: !f.repo ? needRepo : repoRows.length === 0 ? "GitHub checks have not completed." : repoFails === 0 ? "No GitHub check fails for this repo." : `${repoFails} GitHub check(s) fail.` },
    { title: "Daemon picks it up", done: f.settings?.status.restartPending === false && f.settings.status.reported && wf?.status === "ok" && live, detail: !f.repo ? needRepo : f.settings?.status.restartPending ? "Restart pending: the daemon loaded an older archangel.yaml." : !live ? "No fresh daemon heartbeat." : wf?.status === "ok" ? "The daemon loaded the file and the repo's workflow is ok." : `The repo's workflow is ${wf?.status ?? "unknown"}.` },
    { title: "Verify", done: f.repo !== null && hasActivity, detail: !f.repo ? needRepo : hasActivity ? "The Ledger has a Thread or Scout run for this repo." : "No Thread or Scout run for this repo yet." },
  ];
  const all = steps.map((s, i): Step => ({ n: i + 1, ...s }));
  const ready = all.every((s) => s.done);
  all.push({ n: 8, title: "You're set up", done: ready, detail: ready ? "Every step is satisfied." : "Finish the earlier steps." });
  return all;
}

/** A prefilled new-issue link: the owner submits it on GitHub, so intake sees an owner-authored, owner-labelled issue. */
export function smokeIssueUrl(repo: string): string {
  const q = new URLSearchParams({
    title: "Archangel smoke test: add a note to the README",
    body: "A tiny change to confirm Archangel is wired up: add one line to the README saying this repo is managed by Archangel.\n\nAcceptance: README.md has the line; tests pass.",
    labels: "ready-for-agent",
  });
  return `https://github.com/${repo}/issues/new?${q}`;
}

/** `/api/gh/protection` answers 502 with gh's 404 message for an unprotected branch: that is a state, not a failure. */
export const isNotProtected = (message: string): boolean => /404|not protected/i.test(message);

interface StepGroup {
  n: number;
  title: string;
  /** Wizard step numbers (1-8) shown under this group. */
  steps: number[];
  done: boolean;
  /** The first unmet step's sentence, or the last step's when all are met. */
  sentence: string;
}

/** The design's six steps over the eight derived ones. Step 8 only adds the "what next" links to the last group. */
const GROUPS: Array<{ title: string; steps: number[] }> = [
  { title: "Tools on this machine", steps: [1] },
  { title: "This machine's settings", steps: [2] },
  { title: "Repos added", steps: [3, 4] },
  { title: "GitHub wiring", steps: [5] },
  { title: "Daemon has the latest settings", steps: [6] },
  { title: "Proven end to end", steps: [7, 8] },
];

export function groupSteps(steps: Step[]): StepGroup[] {
  return GROUPS.map((g, i) => {
    const mine = g.steps.filter((n) => n !== 8).map((n) => steps[n - 1]!);
    const next = mine.find((s) => !s.done);
    return { n: i + 1, title: g.title, steps: g.steps, done: next === undefined, sentence: (next ?? mine[mine.length - 1]!).detail };
  });
}
