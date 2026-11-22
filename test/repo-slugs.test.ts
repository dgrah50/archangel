import { describe, expect, it } from "vitest";
import { HostYamlSchema, REPO_SLUG_RE } from "../src/config.js";
import type { OnboardRunner } from "../src/core/onboard.js";
import { planWorkflowProposal } from "../src/core/workflow-propose.js";

const project = (repo: string) => ({ repo });
const host = (...repos: string[]) => HostYamlSchema.safeParse({ ownerUserId: 1, projects: repos.map(project) });

describe("repo slugs", () => {
  it("accepts GitHub-shaped owner/name and rejects spaces, URL metacharacters and dot segments", () => {
    for (const ok of ["acme/app", "Acme-Inc/my_repo.js", "dgrah50/.github", "a/b"]) expect(REPO_SLUG_RE.test(ok), ok).toBe(true);
    for (const bad of ["acme/..", "acme/.", "../app", "acme/a b", "acme/app?x=1", "acme/app#frag", "acme/a&b", "acme/app/extra", "-acme/app", "acme", "/app", "acme/"]) {
      expect(REPO_SLUG_RE.test(bad), bad).toBe(false);
    }
  });

  it("rejects a loose slug in the host config and in commands that interpolate it into gh/REST paths", async () => {
    expect(host("acme/app?x=1").success).toBe(false);
    expect(host("acme/..").success).toBe(false);
    const runner: OnboardRunner = { async run() { throw new Error("must not be called"); } };
    await expect(planWorkflowProposal(runner, "acme/..", "{}")).rejects.toThrow(/Expected owner\/name/);
  });
});

describe("duplicate projects", () => {
  it("rejects the same repo twice, including when the names differ only by case", () => {
    expect(host("acme/app", "acme/other").success).toBe(true);
    for (const dup of [["acme/app", "acme/app"], ["acme/app", "ACME/App"]]) {
      const r = host(...dup);
      expect(r.success, dup.join(",")).toBe(false);
      expect(!r.success && r.error.issues[0]!.message).toContain("duplicate project");
    }
  });
});
