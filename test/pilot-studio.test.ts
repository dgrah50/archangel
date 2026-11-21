import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSetupPlan,
  installGateWorkflow,
  parsePilotIssuesMarkdown,
  renderMainRulesetJson,
  validateArmSelection,
} from "../scripts/setup-gijq-pilot.js";
import { buildStudioSpawnSpec } from "../src/core/studio.js";

describe("pilot setup script & read-only Studio (Neon P4 & P5)", () => {
  it("parses all 10 curated gijq issues, guards conflicting autocomplete arms, installs pinned workflow, and renders ruleset", () => {
    const md = fs.readFileSync(path.resolve("docs/GIJQ-PILOT-ISSUES.md"), "utf8");
    const specs = parsePilotIssuesMarkdown(md);
    expect(specs).toHaveLength(10);
    expect(specs[0]?.packageHint).toBe("autocomplete");
    expect(specs[9]?.packageHint).toBe("clipboard");

    const plan = buildSetupPlan(specs, new Set([specs[0]!.title]));
    expect(plan.toCreate).toHaveLength(9);
    expect(plan.skipped).toHaveLength(1);

    // Refuses arming two autocomplete issues simultaneously
    expect(validateArmSelection(specs, [1, 2]).ok).toBe(false);
    // Allows 1 autocomplete + 1 clipboard issue
    expect(validateArmSelection(specs, [1, 10]).ok).toBe(true);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-wf-"));
    try {
      const sha = "a".repeat(40);
      const dest = installGateWorkflow({
        sourceWorkflowPath: path.resolve("workflows/archangel-gate.yml"),
        targetRepoDir: tmp,
        pinnedSha: sha,
      });
      const written = fs.readFileSync(dest, "utf8");
      expect(written).toContain(`ARCHANGEL_GATE_SHA: ${sha}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    const ruleset = renderMainRulesetJson();
    expect(ruleset.bypass_actors).toEqual([]);
  });

  it("enforces Studio loopback host, separate DBs, and secret scrubbing", () => {
    expect(() =>
      buildStudioSpawnSpec({ mastraDbPath: "/tmp/a.db", ledgerDbPath: "/tmp/a.db" }),
    ).toThrow(/mastraDbPath === ledgerDbPath/);

    expect(() =>
      buildStudioSpawnSpec({ mastraDbPath: "/tmp/m.db", ledgerDbPath: "/tmp/l.db", host: "0.0.0.0" }),
    ).toThrow(/loopback/);

    const spec = buildStudioSpawnSpec({ mastraDbPath: "/tmp/m.db", ledgerDbPath: "/tmp/l.db", port: 4111 });
    expect(spec.url).toBe("http://127.0.0.1:4111");
    expect(spec.env.ARCHANGEL_GITHUB_PRIVATE_KEY_PEM).toBeUndefined();
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spec.env.ARCHANGEL_MASTRA_DB).toBe(path.resolve("/tmp/m.db"));
  });
});
