import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PilotIssueSpec {
  index: number;
  title: string;
  body: string;
  packageHint: string;
  labels: string[];
}

export const PILOT_LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: "ready-for-agent", color: "0E8A16", description: "Owner-approved for Archangel autonomous execution" },
  { name: "factory:paused", color: "FBCA04", description: "Pause Archangel autonomy on this Thread" },
  { name: "factory:stop", color: "B60205", description: "Immediate kill switch for Archangel on this Thread" },
  { name: "needs-you", color: "D93F0B", description: "Archangel escalation awaiting owner input" },
  { name: "factory:disagree", color: "5319E7", description: "Shadow Mode disagreement marker" },
  { name: "theme:reliability", color: "1D76DB", description: "Pilot Theme: Autocomplete, UI & Clipboard Reliability" },
];

/**
 * Parses `docs/GIJQ-PILOT-ISSUES.md` into structured, reproducible GitHub issue specs.
 */
export function parsePilotIssuesMarkdown(markdown: string): PilotIssueSpec[] {
  const sections = markdown.split(/^### Issue (\d+) — /m);
  const issues: PilotIssueSpec[] = [];
  for (let i = 1; i + 1 < sections.length; i += 2) {
    const index = Number(sections[i]);
    const block = sections[i + 1]!.trim();
    const newlineIdx = block.indexOf("\n");
    const title = (newlineIdx >= 0 ? block.slice(0, newlineIdx) : block).trim();
    const body = (newlineIdx >= 0 ? block.slice(newlineIdx + 1) : "").trim();
    const fileMatch = body.match(/\*\*File:\*\*\s*`([^`]+)`/);
    const filePath = fileMatch?.[1] ?? "";
    const packageHint = filePath.includes("autocomplete")
      ? "autocomplete"
      : filePath.includes("ui/")
        ? "ui"
        : filePath.includes("clipboard")
          ? "clipboard"
          : "other";
    issues.push({
      index,
      title,
      body,
      packageHint,
      labels: ["theme:reliability"],
    });
  }
  return issues;
}

export function validateArmSelection(
  specs: PilotIssueSpec[],
  armIndices: number[],
  allowConflicts = false,
): { ok: true; selected: PilotIssueSpec[] } | { ok: false; error: string } {
  const selected: PilotIssueSpec[] = [];
  for (const idx of armIndices) {
    const found = specs.find((s) => s.index === idx);
    if (!found) {
      return { ok: false, error: `Unknown pilot issue index: ${idx}` };
    }
    selected.push(found);
  }
  if (!allowConflicts) {
    const ac = selected.filter((s) => s.packageHint === "autocomplete");
    if (ac.length > 1) {
      return {
        ok: false,
        error: `Refusing to arm multiple conflicting internal/autocomplete issues simultaneously (${ac
          .map((s) => `#${s.index}`)
          .join(", ")}). Pair 1 autocomplete + 1 ui/clipboard issue, or pass --allow-conflicts.`,
      };
    }
  }
  return { ok: true, selected };
}

export function buildSetupPlan(
  specs: PilotIssueSpec[],
  existingTitles: Set<string>,
): { toCreate: PilotIssueSpec[]; skipped: PilotIssueSpec[] } {
  const toCreate: PilotIssueSpec[] = [];
  const skipped: PilotIssueSpec[] = [];
  for (const s of specs) {
    if (existingTitles.has(s.title)) {
      skipped.push(s);
    } else {
      toCreate.push(s);
    }
  }
  return { toCreate, skipped };
}

export function installGateWorkflow(opts: {
  sourceWorkflowPath: string;
  targetRepoDir: string;
  pinnedSha: string;
}): string {
  if (!/^[0-9a-f]{40}$/.test(opts.pinnedSha)) {
    throw new Error(`pinnedSha must be a 40-char commit SHA, got: ${opts.pinnedSha}`);
  }
  const content = fs
    .readFileSync(opts.sourceWorkflowPath, "utf8")
    .replace("REPLACE_WITH_PINNED_ARCHANGEL_COMMIT_SHA", opts.pinnedSha);
  const dest = path.join(opts.targetRepoDir, ".github", "workflows", "archangel-gate.yml");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, "utf8");
  return dest;
}

export function renderMainRulesetJson(): Record<string, unknown> {
  return {
    name: "Archangel Main Protection",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: {
      ref_name: {
        include: ["refs/heads/main"],
        exclude: [],
      },
    },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash"],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [
            { context: "Gate", integration_id: 15368 },
            { context: "Test (ubuntu-latest)", integration_id: 15368 },
            { context: "Test (macos-latest)", integration_id: 15368 },
          ],
        },
      },
    ],
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const allowConflicts = args.includes("--allow-conflicts");
  const printRuleset = args.includes("--print-ruleset");
  const repoIdx = args.indexOf("--repo");
  const repo = repoIdx >= 0 && args[repoIdx + 1] ? args[repoIdx + 1]! : "dgrah50/gijq";

  if (printRuleset) {
    console.log(JSON.stringify(renderMainRulesetJson(), null, 2));
    return;
  }

  const mdPath = path.resolve("docs/GIJQ-PILOT-ISSUES.md");
  const specs = parsePilotIssuesMarkdown(fs.readFileSync(mdPath, "utf8"));

  const armIdx = args.indexOf("--arm");
  const armIndices =
    armIdx >= 0 && args[armIdx + 1]
      ? args[armIdx + 1]!
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n))
      : [];

  const armCheck = validateArmSelection(specs, armIndices, allowConflicts);
  if (!armCheck.ok) {
    console.error(armCheck.error);
    process.exit(1);
  }

  const wfIdx = args.indexOf("--install-workflow");
  const targetRepoDir = wfIdx >= 0 ? args[wfIdx + 1] : undefined;

  if (!apply) {
    console.log(`[dry-run] Target repo: ${repo}`);
    console.log(`[dry-run] Labels to ensure (${PILOT_LABELS.length}): ${PILOT_LABELS.map((l) => l.name).join(", ")}`);
    console.log(`[dry-run] Pilot issues parsed from docs/GIJQ-PILOT-ISSUES.md: ${specs.length}`);
    for (const s of specs) {
      console.log(`  #${s.index} [${s.packageHint}] ${s.title}`);
    }
    if (armCheck.selected.length > 0) {
      console.log(`[dry-run] Would arm with ready-for-agent: ${armCheck.selected.map((s) => `#${s.index}`).join(", ")}`);
    }
    if (targetRepoDir) {
      console.log(`[dry-run] Would install pinned archangel-gate.yml into ${targetRepoDir}`);
    }
    console.log("\nPass --apply to execute against GitHub via `gh`.");
    return;
  }

  // Live mode via authenticated `gh` CLI (owner-authored issues & labels per ADR-0004).
  const userJson = JSON.parse(execFileSync("gh", ["api", "user"], { encoding: "utf8" })) as {
    login: string;
    id: number;
  };
  console.log(`Authenticated as ${userJson.login} (ownerUserId: ${userJson.id})`);

  for (const lbl of PILOT_LABELS) {
    execFileSync(
      "gh",
      ["label", "create", lbl.name, "--repo", repo, "--color", lbl.color, "--description", lbl.description, "--force"],
      { stdio: "inherit" },
    );
  }

  const existingRaw = execFileSync(
    "gh",
    ["issue", "list", "--repo", repo, "--state", "all", "--limit", "200", "--json", "number,title"],
    { encoding: "utf8" },
  );
  const existingList = JSON.parse(existingRaw) as Array<{ number: number; title: string }>;
  const titleToNumber = new Map(existingList.map((i) => [i.title, i.number]));
  const plan = buildSetupPlan(specs, new Set(titleToNumber.keys()));

  for (const spec of plan.toCreate) {
    const url = execFileSync(
      "gh",
      ["issue", "create", "--repo", repo, "--title", spec.title, "--body", spec.body, "--label", spec.labels.join(",")],
      { encoding: "utf8" },
    ).trim();
    const numMatch = url.match(/\/issues\/(\d+)$/);
    if (numMatch?.[1]) {
      titleToNumber.set(spec.title, Number(numMatch[1]));
    }
    console.log(`Created issue #${spec.index}: ${url}`);
  }
  if (plan.skipped.length > 0) {
    console.log(`Skipped ${plan.skipped.length} already-existing issue(s).`);
  }

  for (const spec of armCheck.selected) {
    const ghNum = titleToNumber.get(spec.title);
    if (!ghNum) continue;
    execFileSync("gh", ["issue", "edit", String(ghNum), "--repo", repo, "--add-label", "ready-for-agent"], {
      stdio: "inherit",
    });
    console.log(`Armed GitHub issue #${ghNum} (pilot #${spec.index}) with ready-for-agent.`);
  }

  if (targetRepoDir) {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dest = installGateWorkflow({
      sourceWorkflowPath: path.resolve("workflows/archangel-gate.yml"),
      targetRepoDir,
      pinnedSha: sha,
    });
    console.log(`Installed pinned Gate workflow at ${dest} (ARCHANGEL_GATE_SHA=${sha}).`);
    console.log(`Next: cd ${targetRepoDir} && git add .github/workflows/archangel-gate.yml && git commit -m "ci: add Archangel Gate" && git push`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
