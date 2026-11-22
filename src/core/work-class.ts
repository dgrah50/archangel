export type WorkClass = "bugfix" | "feature";

/**
 * A Thread's work class is encoded in its branch name, which only the daemon chooses (the broker pushes
 * exactly `thread.branchName`; the implementer cannot name it). The Gate workflow reads the same branch
 * name, so the class the daemon decided from the owner-verified issue label is the class the Gate sees.
 */
export const FEATURE_BRANCH_RE = /^factory\/feature-\d+$/;

export function branchNameFor(workClass: WorkClass, issueNumber: number): string {
  return workClass === "feature" ? `factory/feature-${issueNumber}` : `factory/${issueNumber}`;
}

export function workClassOfBranch(branchName: string): WorkClass {
  return FEATURE_BRANCH_RE.test(branchName) ? "feature" : "bugfix";
}
