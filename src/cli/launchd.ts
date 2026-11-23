import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { UI_DIST_DIR } from "../core/ui-server.js";
import { resolveUiSettings } from "./data-dir.js";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const LAUNCHD_LABEL = "com.archangel.daemon";
const UI_LAUNCHD_LABEL = "com.archangel.ui";
function launchdPlistPath(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}
function launchdUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 501;
}

/** One launchd agent: restart on failure, logs to `<logDir>/<logName>.log` and `.err.log`. Never put a secret in here. */
function renderPlist(a: { label: string; args: string[]; workDir: string; logDir: string; logName: string }): string {
  // Capture current PATH so launchd can locate bun, git, go, codex, claude, and agy.
  const capturedPath = process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${a.label}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(a.workDir)}</string>
  <key>ProgramArguments</key>
  <array>
${a.args.map((x) => `    <string>${escapeXml(x)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(capturedPath)}</string>
    <key>HOME</key>
    <string>${escapeXml(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(a.logDir, `${a.logName}.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(a.logDir, `${a.logName}.err.log`))}</string>
</dict>
</plist>
`;
}

function bootoutAgent(label: string): void {
  try {
    execFileSync("launchctl", ["bootout", `gui/${launchdUid()}/${label}`], { stdio: "ignore" });
  } catch (_err) {
    // launchctl bootout exits non-zero when the agent is not currently loaded.
    void _err;
  }
}

function installAgent(a: { label: string; args: string[]; workDir: string; logDir: string; logName: string }): void {
  const plistPath = launchdPlistPath(a.label);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, renderPlist(a), { encoding: "utf8", mode: 0o600 });
  bootoutAgent(a.label);
  // bootout returns before launchd has stopped the job (the daemon has a 15 s shutdown deadline); bootstrapping a label that
  // is still loaded fails with EIO 5 and leaves nothing running. Wait until it is really gone.
  const target = `gui/${launchdUid()}/${a.label}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      execFileSync("launchctl", ["print", target], { stdio: "ignore" });
    } catch (_err) {
      void _err;
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`${a.label} is still loaded 30 s after bootout; not bootstrapping over it. Run \`launchctl bootout ${target}\` by hand, then retry.`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  execFileSync("launchctl", ["bootstrap", `gui/${launchdUid()}`, plistPath], { stdio: "inherit" });
  console.log(`Installed & loaded ${a.label} (${plistPath}).`);
}

function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(1000);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(false));
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function registerDaemon(program: Command): void {
  const daemonCmd = program
    .command("daemon")
    .description("Manage the always-on macOS launchd user agent (fixed checkout, no secrets in plist)");

  daemonCmd
    .command("install")
    .description("Write and load the daemon (com.archangel.daemon) and dashboard (com.archangel.ui) launchd agents in ~/Library/LaunchAgents")
    .option("-c, --config <path>", "Path to archangel.yaml")
    .action(async (opts: { config?: string }) => {
      if (process.platform !== "darwin") {
        throw new Error("`archangel daemon install` currently supports macOS (launchd) only.");
      }
      const workDir = process.cwd();
      const entryTs = path.resolve(workDir, "src/cli/index.ts");
      if (!fs.existsSync(entryTs)) {
        throw new Error(`CLI entry not found at ${entryTs}. Run \`daemon install\` from the Archangel checkout.`);
      }
      const configPath = path.resolve(workDir, opts.config ?? "archangel.yaml");
      const logDir = path.resolve(workDir, ".archangel");
      fs.mkdirSync(logDir, { recursive: true });
      // The dashboard cannot be served without its bundle; installing it anyway would crash-loop.
      if (!fs.existsSync(path.join(UI_DIST_DIR, "index.html"))) {
        throw new Error(`The dashboard is not built (${path.join(UI_DIST_DIR, "index.html")} is missing). Run \`bun run build\`, then \`daemon install\` again.`);
      }
      const ui = resolveUiSettings({ config: configPath });
      const portBusy = await isPortInUse(ui.host, ui.port);

      // Never write secrets into the plist; Archangel loads `.env` (chmod 600) at runtime.
      // `bun` as found on PATH (a stable symlink such as /opt/homebrew/bin/bun), not this process's own binary: that is a versioned
      // path which the next `brew upgrade bun` deletes, leaving both agents unable to start.
      const bun = Bun.which("bun") ?? process.execPath;
      installAgent({ label: LAUNCHD_LABEL, args: [bun, entryTs, "start", "--config", configPath], workDir, logDir, logName: "daemon" });
      installAgent({ label: UI_LAUNCHD_LABEL, args: [bun, entryTs, "ui", "--config", configPath], workDir, logDir, logName: "ui" });
      console.log(`Daemon logs: ${path.join(logDir, "daemon.log")} and ${path.join(logDir, "daemon.err.log")}`);
      console.log(`Dashboard: http://${ui.host.includes(":") ? `[${ui.host}]` : ui.host}:${ui.port}  (logs: ${path.join(logDir, "ui.log")} and ${path.join(logDir, "ui.err.log")})`);
      if (portBusy) {
        console.warn(`WARNING: ${ui.host}:${ui.port} is already in use (likely a dashboard started by hand). The managed dashboard will keep failing to bind until that process is stopped.`);
      }
    });

  daemonCmd
    .command("restart")
    .description("Restart the loaded launchd agent (SIGTERM, wait for the Ledger lock to be released, kickstart)")
    .action(() => {
      if (process.platform !== "darwin") {
        throw new Error("`archangel daemon restart` currently supports macOS (launchd) only.");
      }
      const target = `gui/${process.getuid!()}/${LAUNCHD_LABEL}`;
      let printed: string;
      try {
        printed = execFileSync("launchctl", ["print", target], { encoding: "utf8" });
      } catch (err) {
        throw new Error(`${LAUNCHD_LABEL} is not loaded in launchd (${err instanceof Error ? err.message : String(err)}). Run \`archangel daemon install\` first.`);
      }
      // `kickstart -k` SIGKILLs after launchd's 20 s ExitTimeOut, and a daemon killed mid-shutdown never releases the Ledger
      // lock: the new one then exits "Another live daemon" and KeepAlive respawns it until the lease goes stale. Instead
      // stop it gently, wait for the old process to exit (which is when it has released the lock), then start it.
      const pidMatch = printed.match(/^\s*pid = (\d+)/m);
      if (pidMatch) {
        const pid = Number(pidMatch[1]);
        execFileSync("launchctl", ["kill", "SIGTERM", target], { stdio: "inherit" });
        const deadline = Date.now() + 30_000;
        while (isProcessAlive(pid)) {
          if (Date.now() > deadline) {
            throw new Error(`Daemon pid ${pid} is still running 30 s after SIGTERM and still holds the Ledger lock; not starting a second one. Stop it by hand, then retry.`);
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
      }
      execFileSync("launchctl", ["kickstart", target], { stdio: "inherit" });
      console.log(`Restarted ${LAUNCHD_LABEL}.`);
      const uiTarget = `gui/${process.getuid!()}/${UI_LAUNCHD_LABEL}`;
      try {
        execFileSync("launchctl", ["print", uiTarget], { stdio: "ignore" });
      } catch (_err) {
        void _err;
        console.log("The dashboard is not a managed service yet: re-run `archangel daemon install` to get it.");
        return;
      }
      execFileSync("launchctl", ["kickstart", "-k", uiTarget], { stdio: "inherit" });
      console.log(`Restarted ${UI_LAUNCHD_LABEL}.`);
    });

  daemonCmd
    .command("uninstall")
    .description("Unload and remove the daemon and dashboard launchd agents (com.archangel.daemon, com.archangel.ui)")
    .action(() => {
      if (process.platform !== "darwin") {
        throw new Error("`archangel daemon uninstall` currently supports macOS (launchd) only.");
      }
      for (const label of [LAUNCHD_LABEL, UI_LAUNCHD_LABEL]) {
        const plistPath = launchdPlistPath(label);
        bootoutAgent(label);
        if (fs.existsSync(plistPath)) {
          fs.rmSync(plistPath);
          console.log(`Unloaded & removed ${plistPath}.`);
        } else {
          console.log(`${plistPath} not present.`);
        }
      }
    });

  daemonCmd
    .command("status")
    .description("Show macOS launchd daemon status")
    .action(() => {
      for (const label of [LAUNCHD_LABEL, UI_LAUNCHD_LABEL]) {
        const plistPath = launchdPlistPath(label);
        console.log(`${label}: ${plistPath} (${fs.existsSync(plistPath) ? "installed" : "not installed"})`);
        if (process.platform === "darwin") {
          try {
            const out = execFileSync("launchctl", ["print", `gui/${launchdUid()}/${label}`], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            });
            const stateLine = out.split("\n").find((l) => l.includes("state =") || l.includes("pid ="));
            console.log(stateLine?.trim() ?? "Loaded");
          } catch (_err) {
            console.log("Not loaded in launchd.");
          }
        }
      }
    });
}
