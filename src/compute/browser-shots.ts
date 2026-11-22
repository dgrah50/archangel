import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execInGroup } from "./local.js";

/**
 * One screenshot of a loopback page, taken by a headless Chromium that runs in its OWN `sandbox-exec` profile: a separate process,
 * a fresh empty profile directory per shot (no cookies, no storage), and no network but loopback. It can read only its own
 * install directory and the system, and write only its per-shot directory. The page it loads is untrusted code; the PNG it
 * writes is untrusted bytes, and the caller re-encodes it (pitch-ingest) before anything stores or shows it.
 */

export const SHOT_WIDTH = 1280;
export const SHOT_HEIGHT = 800;
const SHOT_TIMEOUT_MS = 30_000;
const PAGE_LOAD_MS = 8_000;
const SYSTEM_READ_DIRS = ["/System", "/Library", "/usr", "/private/etc", "/private/var/db", "/dev"];

const q = (p: string): string => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const sub = (dirs: string[]): string => dirs.map((d) => `(subpath ${q(d)})`).join(" ");

/** Real paths only (`/tmp` is `/private/tmp`). */
export function buildBrowserProfile(opts: { browserDir: string; out: string }): string {
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    `(allow process-exec ${sub([opts.browserDir])})`,
    `(allow file-read* (literal "/") ${sub([opts.browserDir, ...SYSTEM_READ_DIRS, opts.out])})`,
    "(allow file-read-metadata)",
    `(allow file-write* (literal "/dev/null") ${sub([opts.out])})`,
    "(allow file-ioctl)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow mach-register)",
    "(allow process-info*)",
    "(allow ipc-posix-shm*)",
    "(allow signal (target self))",
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "(allow system-socket)",
    "",
  ].join("\n");
}

/** `ARCHANGEL_BROWSER`, else the newest headless shell Playwright installed (`bunx playwright install chromium-headless-shell`). */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.ARCHANGEL_BROWSER) return env.ARCHANGEL_BROWSER;
  const cache = env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(home, "Library", "Caches", "ms-playwright");
  const versions = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => d.startsWith("chromium_headless_shell-")).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])) : [];
  for (const v of versions) {
    for (const arch of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64"]) {
      const bin = path.join(cache, v, arch, "chrome-headless-shell");
      if (fs.existsSync(bin)) return bin;
    }
  }
  throw new Error("no headless browser found: run `bunx playwright install chromium-headless-shell` or set ARCHANGEL_BROWSER");
}

/** The PNG bytes of `url` at 1280x800. Rejects when the browser fails or writes nothing. */
export async function screenshotUrl(url: string, browser: string = findBrowser()): Promise<Buffer> {
  if (process.platform !== "darwin") throw new Error("no sandbox: sandbox-exec exists only on macOS");
  if (!/^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(url)) throw new Error("screenshots are taken of loopback URLs only");
  const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "archangel-shot-")));
  try {
    const profile = path.join(out, "profile.sb");
    fs.writeFileSync(profile, buildBrowserProfile({ browserDir: fs.realpathSync(path.dirname(browser)), out }));
    const file = path.join(out, "shot.png");
    const res = await execInGroup(out, {
      cmd: "sandbox-exec",
      args: [
        "-f", profile, browser,
        "--no-sandbox", // Chromium's own sandbox cannot nest inside Seatbelt; the outer profile is the boundary
        "--disable-gpu",
        `--user-data-dir=${path.join(out, "user-data")}`,
        `--window-size=${SHOT_WIDTH},${SHOT_HEIGHT}`,
        "--hide-scrollbars",
        `--timeout=${PAGE_LOAD_MS}`,
        "--virtual-time-budget=4000", // lets a single-page app fetch and render before the shot
        `--screenshot=${file}`,
        url,
      ],
      env: { HOME: out, TMPDIR: out, PATH: "/usr/bin:/bin" },
      timeoutMs: SHOT_TIMEOUT_MS,
    });
    if (!fs.existsSync(file)) throw new Error(`the browser wrote no screenshot (exit ${res.code}): ${res.stderr.slice(-300)}`);
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}
