import { expect, test } from "bun:test";
import { buildImplementPrompt } from "../src/agents/prompts.js";
import { loadRepoInstructions } from "../src/core/workflow-load.js";

test("the prompt carries the repo's AGENTS.md from the base commit; an import-only CLAUDE.md adds nothing", async () => {
  const files: Record<string, string> = { "AGENTS.md": "Few tests.", "CLAUDE.md": "@AGENTS.md\n" };
  const reader = { readFileAtRef: async (ref: string, path: string) => (ref === "main-sha" ? (files[path] ?? null) : null) };
  const repoInstructions = await loadRepoInstructions(reader, "main-sha");
  const prompt = buildImplementPrompt({ issueNumber: 1, title: "t", body: "b", repoName: "o/r", repoInstructions });
  expect(prompt).toContain("### AGENTS.md\nFew tests.");
  expect(prompt).not.toContain("### CLAUDE.md");
});
