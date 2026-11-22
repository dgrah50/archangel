import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { HostYamlSchema, resolveConfigPath } from "../config.js";
import type { Ledger } from "../ledger/store.js";
import { ENV_FEATURES, buildHostStatus, type HostStatus } from "./host-facts.js";
import { KERNEL } from "./workflow.js";

type HostYaml = z.infer<typeof HostYamlSchema>;

export interface SettingsState {
  generatedAt: number;
  /** The file on disk, validated with the daemon's own schema. Only schema fields reach the browser (it is strict, and holds no secrets). */
  host: { state: "ok"; config: HostYaml } | { state: "missing" | "invalid" | "unreadable"; error: string };
  status: HostStatus;
  /** By name only. `set` is what the daemon saw when it started; null means it has not reported. */
  env: Array<{ name: string; feature: string; set: boolean | null }>;
  kernel: { maxNonTestLines: number; maxTotalLines: number; maxFiles: number; minBaseTestRuns: number; minHeadTestRuns: number; universalProtected: string[]; gateCheck: string; reviewQuorum: number; maxScouts: number };
}

const clip = (s: string) => (s.length > 600 ? `${s.slice(0, 600)}...` : s);

/** Pure read: nothing is written and no environment value is read (presence comes from the daemon's recorded booleans). */
export function buildSettingsState(ledger: Ledger, configPath: string | undefined, now = Date.now()): SettingsState {
  const file = resolveConfigPath(configPath);
  let host: SettingsState["host"];
  if (!fs.existsSync(file)) host = { state: "missing", error: `No archangel.yaml at ${file}` };
  else {
    try {
      const parsed = HostYamlSchema.safeParse(parseYaml(fs.readFileSync(file, "utf8")));
      host = parsed.success ? { state: "ok", config: parsed.data } : { state: "invalid", error: clip(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")) };
    } catch (e) {
      host = { state: "unreadable", error: clip(e instanceof Error ? e.message : String(e)) };
    }
  }
  const status = buildHostStatus(ledger, configPath, now);
  return {
    generatedAt: now,
    host,
    status,
    env: ENV_FEATURES.map((e) => ({ ...e, set: status.envPresence ? (status.envPresence[e.name] ?? null) : null })),
    kernel: {
      maxNonTestLines: KERNEL.maxNonTestLines,
      maxTotalLines: KERNEL.maxTotalLines,
      maxFiles: KERNEL.maxFiles,
      minBaseTestRuns: KERNEL.minBaseTestRuns,
      minHeadTestRuns: KERNEL.minHeadTestRuns,
      universalProtected: [...KERNEL.universalProtectedPrefixes, ...KERNEL.universalProtectedExact],
      gateCheck: KERNEL.gateCheck,
      reviewQuorum: KERNEL.reviewQuorum,
      maxScouts: KERNEL.maxScouts,
    },
  };
}
