import type { ReviewRecord, ReviewerVendor } from "../ledger/schema.js";

export interface CheckStatus {
  id?: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  appSlug?: string | null;
}

export const TRUSTED_CHECK_APP_SLUG = "github-actions" as const;

export function dedupeChecksByLatestId<T extends CheckStatus>(checks: readonly T[]): Map<string, T> {
  const latestByName = new Map<string, T>();
  for (const c of checks) {
    const prev = latestByName.get(c.name);
    if (!prev || (c.id ?? 0) >= (prev.id ?? 0)) {
      latestByName.set(c.name, c);
    }
  }
  return latestByName;
}

export interface LandingSnapshot {
  prOpen: boolean;
  prDraft: boolean;
  headSha: string;
  shaRecordedByBroker: boolean;
  postHandoff: boolean;
  labels: string[];
  pauseLabel: string;
  stopLabel: string;
  circuitBreakerTripped: boolean;
  mainTipGreen: boolean;
  branchUpToDateWithMain: boolean;
  protectedFilesTouched: string[];
  requiredChecks: string[];
  checks: CheckStatus[];
  reviewsForHeadSha: ReviewRecord[];
  requiredReviewers: ReviewerVendor[];
  mergeTreeClean: boolean;
  autoMergesToday: number;
  maxAutoMergesPerDay: number;
  shadowMode: boolean;
  ownerMergeThread?: boolean;
  agentDraft?: boolean;
}

export interface Blocker {
  code:
    | "pr_not_open"
    | "pr_draft"
    | "paused"
    | "stopped"
    | "post_handoff_owner_only"
    | "circuit_breaker_tripped"
    | "main_not_green"
    | "unverified_head_sha"
    | "protected_paths_touched"
    | "branch_behind_main"
    | "check_missing"
    | "check_pending"
    | "check_failed"
    | "check_untrusted_source"
    | "review_missing"
    | "review_vetoed"
    | "insufficient_independent_reviewers"
    | "merge_conflict"
    | "daily_merge_cap_reached"
    | "shadow_mode_active"
    | "agent_draft_owner_only";
  message: string;
}

export function computeBlockers(s: LandingSnapshot): Blocker[] {
  const blockers: Blocker[] = [];

  if (s.agentDraft) {
    blockers.push({ code: "agent_draft_owner_only", message: "Machine-drafted change (agent-draft/*): only the owner merges it, by hand" });
  }

  if (!s.prOpen) blockers.push({ code: "pr_not_open", message: "PR is not open" });
  if (s.prDraft) blockers.push({ code: "pr_draft", message: "PR is still a draft" });
  if (s.labels.includes(s.stopLabel)) {
    blockers.push({ code: "stopped", message: `Kill switch active (${s.stopLabel})` });
  }
  if (s.labels.includes(s.pauseLabel)) {
    blockers.push({ code: "paused", message: `Factory paused (${s.pauseLabel})` });
  }
  if (s.postHandoff) {
    blockers.push({
      code: "post_handoff_owner_only",
      message: "Post-handoff PRs are advisory only and must be merged by the owner",
    });
  }
  if (s.circuitBreakerTripped) {
    blockers.push({
      code: "circuit_breaker_tripped",
      message: "Global landing circuit breaker is tripped due to red main",
    });
  }
  if (!s.mainTipGreen) {
    blockers.push({ code: "main_not_green", message: "main tip CI is not green or missing required checks" });
  }
  if (!s.shaRecordedByBroker) {
    blockers.push({
      code: "unverified_head_sha",
      message: `head SHA ${s.headSha.slice(0, 8)} was not pushed by Archangel Broker`,
    });
  }
  if (s.protectedFilesTouched.length > 0) {
    blockers.push({
      code: "protected_paths_touched",
      message: `Protected paths touched: ${s.protectedFilesTouched.join(", ")}`,
    });
  }
  if (!s.branchUpToDateWithMain) {
    blockers.push({
      code: "branch_behind_main",
      message: "Branch base SHA is behind current main tip; Gate must run against current main",
    });
  }

  const latestByName = dedupeChecksByLatestId(s.checks);

  for (const reqName of s.requiredChecks) {
    const match = latestByName.get(reqName);
    if (!match) {
      blockers.push({ code: "check_missing", message: `Required check missing: ${reqName}` });
      continue;
    }
    if (match.appSlug !== TRUSTED_CHECK_APP_SLUG) {
      blockers.push({
        code: "check_untrusted_source",
        message: `Check ${reqName} came from untrusted or missing app (${match.appSlug ?? "none"})`,
      });
      continue;
    }
    if (match.status !== "completed") {
      blockers.push({ code: "check_pending", message: `Check pending: ${reqName}` });
    } else if (match.conclusion !== "success") {
      blockers.push({
        code: "check_failed",
        message: `Check failed: ${reqName} (${match.conclusion ?? "unknown"})`,
      });
    }
  }

  if (s.requiredReviewers.length < 2) {
    blockers.push({
      code: "insufficient_independent_reviewers",
      message: `Fewer than 2 independent reviewers available (${s.requiredReviewers.length}); owner review required`,
    });
  }

  for (const vendor of s.requiredReviewers) {
    const rev = s.reviewsForHeadSha.find((r) => r.vendor === vendor && r.headSha === s.headSha);
    if (!rev) {
      blockers.push({
        code: "review_missing",
        message: `Missing independent ${vendor} review for ${s.headSha.slice(0, 8)}`,
      });
    } else if (rev.verdict !== "approve") {
      blockers.push({
        code: "review_vetoed",
        message: `Independent ${vendor} reviewer vetoed ${s.headSha.slice(0, 8)}`,
      });
    }
  }

  if (!s.mergeTreeClean) {
    blockers.push({ code: "merge_conflict", message: "git merge-tree reports merge conflicts" });
  }
  if (s.autoMergesToday >= s.maxAutoMergesPerDay) {
    blockers.push({
      code: "daily_merge_cap_reached",
      message: `Daily auto-merge cap reached (${s.autoMergesToday}/${s.maxAutoMergesPerDay})`,
    });
  }
  if (s.shadowMode && s.ownerMergeThread) {
    blockers.push({
      code: "shadow_mode_active",
      message: "Owner merges (feature and chore Threads never merge autonomously)",
    });
  } else if (s.shadowMode) {
    blockers.push({
      code: "shadow_mode_active",
      message:
        "Shadow Mode active — would merge (owner merges manually; add factory:disagree if you disagree)",
    });
  }

  return blockers;
}

export function isShadowReady(blockers: Blocker[]): boolean {
  return blockers.length === 1 && blockers[0]?.code === "shadow_mode_active";
}
