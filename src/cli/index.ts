#!/usr/bin/env bun
import { Command } from "commander";
import { ConfigError } from "../config.js";
import { loadDotEnv } from "../env.js";
import { registerEval } from "./eval.js";
import { registerDaemon } from "./launchd.js";
import { registerOps } from "./ops.js";
import { registerPitch } from "./pitch.js";
import { registerReports } from "./reports.js";
import { registerStart } from "./start.js";
import { registerThreads } from "./threads.js";

// Auto-load the working directory's `.env` before reading config (never overrides existing shell env). The `.env` beside the host config is loaded with it.
loadDotEnv();

const program = new Command();

program
  .name("archangel")
  .description("Archangel autonomous software factory CLI")
  .version("0.1.0");

registerStart(program);
registerOps(program);
registerThreads(program);
registerReports(program);
registerEval(program);
registerPitch(program);
registerDaemon(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  if (err instanceof ConfigError) console.error(`Fix: ${err.remediation}`);
  process.exit(1);
});
