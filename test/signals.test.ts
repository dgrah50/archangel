import { describe, expect, it } from "bun:test";
import { HostYamlSchema } from "../src/config.js";
import { SignalsConfigSchema, type SignalsConfig } from "../src/core/signal-rules.js";
import { convergeSignals, recordSignal, type SignalActions } from "../src/core/signals.js";
import { Ledger } from "../src/ledger/store.js";

const NOW = Date.UTC(2026, 5, 10, 15);
const DAY = 86_400_000;

function setup(rules: unknown[], extra: Record<string, unknown> = {}) {
  const ledger = new Ledger(":memory:", { repo: "o/r" });
  const filed: string[] = [];
  const scouts: Array<{ scout: string; pitchOnly: boolean }> = [];
  const actions: SignalActions = {
    fileIssue: async ({ title }) => (filed.push(title), filed.length),
    runScout: async (s) => (scouts.push(s), "ran"),
  };
  const cfg = SignalsConfigSchema.parse({ enabled: true, rules, ...extra });
  const tick = (now: number, c: SignalsConfig = cfg) => convergeSignals({ cfg: c, ledger, actions, canRunScouts: true, now });
  return { ledger, filed, scouts, cfg, tick };
}

const chore = (over: Record<string, unknown> = {}) => ({ name: "merged-chore", on: "pr_merged", do: { action: "file_issue", class: "chore", title: "Review merged PR" }, ...over });

describe("signal layer", () => {
  it("ingesting the same event twice stores one signal", () => {
    const { ledger } = setup([]);
    expect(recordSignal(ledger, "pr_merged", "7", { number: 7 }, NOW)).toBe(true);
    expect(recordSignal(ledger, "pr_merged", "7", { number: 7 }, NOW)).toBe(false);
    expect(ledger.listSignals(0)).toHaveLength(1);
  });

  it("an untrusted signal can only start a pitch: such a rule fails config load, and the evaluator refuses one that slips past", async () => {
    const host = (rule: unknown) => HostYamlSchema.safeParse({ ownerUserId: 1, projects: [{ repo: "o/r" }], signals: { enabled: true, rules: [rule] } });
    const advisory = (action: Record<string, unknown>) => ({ name: "cve", on: "advisory", do: action });
    expect(host(advisory({ action: "file_issue", class: "bug", title: "Fix the advisory" })).success).toBe(false);
    expect(host(advisory({ action: "run_scout", scout: "self-audit" })).success).toBe(false);
    expect(host(advisory({ action: "run_pitch", scout: "fleet-pr-miner" })).success).toBe(true);

    const { ledger, filed, tick, cfg } = setup([]);
    recordSignal(ledger, "advisory", "1", { number: 1, severity: "high", ghsaId: "GHSA-abcd-1234-wxyz" }, NOW);
    const bypass = { ...cfg, rules: [{ ...chore({ name: "cve", on: "advisory" }), maxPerDay: 1 }] } as SignalsConfig;
    await tick(NOW, bypass);
    expect(filed).toHaveLength(0);
  });

  it("a rule's daily cap holds", async () => {
    const { ledger, filed, tick } = setup([chore({ maxPerDay: 2 })]);
    for (const n of [1, 2, 3]) recordSignal(ledger, "pr_merged", String(n), { number: n }, NOW);
    await tick(NOW);
    await tick(NOW + 1000);
    expect(filed).toHaveLength(2);
    await tick(NOW + DAY);
    expect(filed).toHaveLength(3);
  });

  it("each signal is actioned once across ticks, and an edited rule reconsiders it", async () => {
    const { ledger, filed, tick, cfg } = setup([chore({ maxPerDay: 10 })]);
    for (const n of [1, 2]) recordSignal(ledger, "pr_merged", String(n), { number: n }, NOW);
    for (let i = 0; i < 3; i++) await tick(NOW + i * 1000);
    expect(filed).toHaveLength(2);
    const edited = SignalsConfigSchema.parse({ ...cfg, rules: [chore({ maxPerDay: 10, do: { action: "file_issue", class: "bug", title: "Review merged PR" } })] });
    await tick(NOW + 5000, edited);
    expect(filed).toHaveLength(4);
  });
});
