export type WorkClass = "bugfix" | "feature" | "chore";

/**
 * A Thread's work class is encoded in its branch name, which only the daemon chooses (the broker pushes
 * exactly `thread.branchName`; the implementer cannot name it). The Gate workflow reads the same branch
 * name, so the class the daemon decided from the owner-verified issue label is the class the Gate sees.
 */
const CLASS_BRANCH_RE = /^factory\/(feature|chore)-\d+$/;

export function branchNameFor(workClass: WorkClass, issueNumber: number): string {
  return workClass === "bugfix" ? `factory/${issueNumber}` : `factory/${workClass}-${issueNumber}`;
}

export function workClassOfBranch(branchName: string): WorkClass {
  return (CLASS_BRANCH_RE.exec(branchName)?.[1] as WorkClass | undefined) ?? "bugfix";
}

/** Features and chores prove nothing red-on-base and never merge autonomously; only bugfixes do either. */
export function ownerMergeClass(workClass: WorkClass): boolean {
  return workClass !== "bugfix";
}
