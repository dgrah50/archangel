import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { Ledger } from "../ledger/store.js";
import { REPO_SLUG_RE } from "../config.js";
import { ARCHANGEL_ROOT, type OnboardRunner } from "./onboard.js";
import { ProposeRefusal, handlePropose } from "./ui-propose.js";
import { makeDoctorHandler, type DoctorRunner, type DoctorScope } from "./ui-doctor.js";
import { buildHostStatus } from "./host-facts.js";
import { listReports } from "./eval-reports.js";
import { buildAccountsState } from "./ui-accounts.js";
import { buildSettingsState } from "./ui-settings.js";
import { buildThreadDetail, readLogs, LOG_MAX } from "./ui-thread.js";
import { makeHostConfigHandler, readHostConfig } from "./ui-host-config.js";
import { makeOnboardHandler } from "./ui-onboard.js";
import { listAllSkills } from "./skills.js";
import { makeGhReads, type GhRead } from "./ui-gh.js";
import { isSchemaBehind, buildUiState, buildWorkflowsState } from "./ui-state.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** Prebuilt dashboard bundle (`npm run build:ui`). */
export const UI_DIST_DIR = path.join(ARCHANGEL_ROOT, "dist/ui");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export function assertBindable(host: string, allowRemote: boolean): void {
  if (!allowRemote && !LOOPBACK.has(host)) {
    throw new Error(`Refusing to bind the read-only UI to non-loopback host ${host}; pass --allow-remote to override.`);
  }
}

/** Error code for a read that hit a table or column the daemon has not migrated into the Ledger yet. */
export const SCHEMA_BEHIND = "ledger_schema_behind";
export const TOKEN_HEADER = "x-archangel-token";
const PROPOSE_PATH = /^\/api\/workflows\/([^/]+)\/propose$/;
const ONBOARD_PATH = /^\/api\/onboard\/([^/]+)$/;
const GH_PATH = /^\/api\/gh\/(repos|user|pr|protection)$/;
const HOST_CONFIG_PATH = "/api/host-config";
const MAX_BODY_BYTES = 1_000_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let refused = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Keep draining (without storing) so the client receives the 413 instead of a reset connection.
        if (!refused) reject(new ProposeRefusal(413, "body too large"));
        refused = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * Serves the static bundle plus GET /api/state and /api/workflows (JSON) from a read-only Ledger.
 * The single non-GET route is `POST /api/workflows/:repo/propose` (only with a `proposeRunner`, never with
 * `allowRemote`): it needs the per-process token embedded in the served page, a loopback Origin and
 * `application/json`, and it can only open an unmerged PR (or preview one). It never writes archangel.yaml.
 */
export async function startUiServer(
  ledger: Ledger,
  opts: { host: string; port: number; allowRemote?: boolean; uiDir?: string; proposeRunner?: OnboardRunner; logFile?: string; configPath?: string; dataDir?: string; doctor?: DoctorRunner; hostConfig?: { configPath: string; audit: (topic: string, payload: Record<string, unknown>, now: number) => void }; onboardAudit?: (topic: string, payload: Record<string, unknown>, now: number) => void },
): Promise<http.Server> {
  assertBindable(opts.host, opts.allowRemote ?? false);
  const uiDir = path.resolve(opts.uiDir ?? UI_DIST_DIR);
  if (!fs.existsSync(path.join(uiDir, "index.html"))) {
    throw new Error(`UI bundle not found at ${uiDir}. Run \`npm run build\` (or \`npm run build:ui\`) first.`);
  }
  const token = crypto.randomBytes(24).toString("hex");
  const proposeEnabled = Boolean(opts.proposeRunner) && !opts.allowRemote;
  /** The token is embedded in the page whenever something that needs it is enabled; never in remote mode. */
  const hostConfigEnabled = Boolean(opts.hostConfig) && !opts.allowRemote;
  /** W3 and R-gh use the owner's `gh` through the same runner as propose; never in remote mode. */
  const onboardEnabled = proposeEnabled && Boolean(opts.onboardAudit);
  const ghReadsEnabled = proposeEnabled;
  const tokenEnabled = !opts.allowRemote && (proposeEnabled || Boolean(opts.doctor) || hostConfigEnabled);
  const tokenOk = (given: string | string[] | undefined): boolean =>
    typeof given === "string" && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
  const hostConfig = opts.hostConfig && hostConfigEnabled ? makeHostConfigHandler(opts.hostConfig) : null;
  const onboard = onboardEnabled ? makeOnboardHandler({ runner: opts.proposeRunner!, audit: opts.onboardAudit! }) : null;
  const ghReads = ghReadsEnabled ? makeGhReads({ runner: opts.proposeRunner! }) : null;
  const doctor = opts.doctor ? makeDoctorHandler(opts.doctor) : null;
  /** Loopback origins (and the bound host) on the port actually bound, which differs from opts.port when it is 0. */
  const originAllowed = (origin: string | undefined): boolean => {
    const port = (server.address() as AddressInfo | null)?.port ?? opts.port;
    return [...LOOPBACK, opts.host].some((h) => origin === `http://${h.includes(":") && !h.startsWith("[") ? `[${h}]` : h}:${port}`);
  };
  const server = http.createServer(async (req, res) => {
    // Loopback-only mode also checks Host to block DNS-rebinding reads from a web page.
    const hostName = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!opts.allowRemote && !LOOPBACK.has(hostName)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const urlPath = (req.url ?? "").split("?")[0]!;
    const proposeMatch = PROPOSE_PATH.exec(urlPath);
    const onboardMatch = ONBOARD_PATH.exec(urlPath);
    if (req.method === "POST" && (proposeMatch || onboardMatch || urlPath === HOST_CONFIG_PATH)) {
      // Every write route passes the same guards: enabled (never in remote mode), token, loopback Origin, JSON, capped body.
      const enabled = proposeMatch ? proposeEnabled : onboardMatch ? onboardEnabled : hostConfigEnabled;
      if (!enabled) return sendJson(res, 403, { error: proposeMatch ? "proposing is disabled (remote mode, or no gh runner)" : onboardMatch ? "onboarding is disabled (remote mode, or not wired)" : "host config writes are disabled (remote mode, or not wired)" });
      if (!tokenOk(req.headers[TOKEN_HEADER])) return sendJson(res, 401, { error: "missing or invalid token" });
      if (!originAllowed(req.headers.origin)) return sendJson(res, 403, { error: "Origin not allowed" });
      if ((req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") {
        return sendJson(res, 415, { error: "Content-Type must be application/json" });
      }
      try {
        const repo = proposeMatch || onboardMatch ? decodeURIComponent((proposeMatch ?? onboardMatch)![1]!) : "";
        if ((proposeMatch || onboardMatch) && !REPO_SLUG_RE.test(repo)) throw new ProposeRefusal(400, "repo must be owner/name");
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          if (err instanceof ProposeRefusal) throw err;
          throw new ProposeRefusal(400, "body is not valid JSON");
        }
        sendJson(res, 200, proposeMatch ? await handlePropose(ledger, opts.proposeRunner!, repo, body) : onboardMatch ? await onboard!(repo, body) : hostConfig!(body));
      } catch (err) {
        if (err instanceof ProposeRefusal) sendJson(res, err.status, { error: err.message });
        else sendJson(res, 500, { error: err instanceof Error ? err.message : "error" });
      }
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" }).end("read-only");
      return;
    }
    try {
      const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      if (pathname === "/api/state") {
        const body = JSON.stringify(buildUiState(ledger));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(body);
        return;
      }
      if (pathname === "/api/workflows") {
        const body = JSON.stringify(buildWorkflowsState(ledger));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(body);
        return;
      }
      if (pathname === "/api/doctor") {
        if (!doctor) return sendJson(res, 404, { error: "doctor is not available" });
        const q = new URL(req.url ?? "/", "http://localhost").searchParams;
        const scope = q.get("scope");
        if (scope !== "machine" && scope !== "repo") return sendJson(res, 400, { error: "scope must be machine or repo" });
        const smoke = q.get("smoke") === "1";
        // Smoke runs spawn provider CLIs and repo checks call GitHub: both need the page's token and are never served remotely.
        if (smoke || scope === "repo") {
          if (opts.allowRemote) return sendJson(res, 403, { error: "disabled in remote mode" });
          if (!tokenOk(req.headers[TOKEN_HEADER])) return sendJson(res, 401, { error: "missing or invalid token" });
        }
        return sendJson(res, 200, await doctor(scope as DoctorScope, smoke));
      }
      const ghMatch = GH_PATH.exec(pathname);
      if (ghMatch) {
        // Reads with the owner's gh: token required (forces a preflight from other origins), never served remotely.
        if (!ghReads) return sendJson(res, 403, { error: "gh reads are disabled (remote mode, or no gh runner)" });
        if (!tokenOk(req.headers[TOKEN_HEADER])) return sendJson(res, 401, { error: "missing or invalid token" });
        try {
          return sendJson(res, 200, await ghReads(ghMatch[1] as GhRead, new URL(req.url ?? "/", "http://localhost").searchParams));
        } catch (err) {
          if (err instanceof ProposeRefusal) return sendJson(res, err.status, { error: err.message });
          throw err;
        }
      }
      if (pathname === "/api/skills") {
        // The bundled skill list for the Scout picker: token required, never served remotely.
        if (opts.allowRemote) return sendJson(res, 403, { error: "skills are disabled in remote mode" });
        if (!tokenOk(req.headers[TOKEN_HEADER])) return sendJson(res, 401, { error: "missing or invalid token" });
        return sendJson(res, 200, { skills: listAllSkills() });
      }
      if (pathname === "/api/accounts") {
        // Cooldowns and homes (paths only) of this machine's logins: token required, never served remotely.
        if (opts.allowRemote) return sendJson(res, 403, { error: "accounts are disabled in remote mode" });
        if (!tokenOk(req.headers[TOKEN_HEADER])) return sendJson(res, 401, { error: "missing or invalid token" });
        return sendJson(res, 200, buildAccountsState(ledger, opts.configPath));
      }
      if (pathname === "/api/evals") return sendJson(res, 200, listReports(opts.dataDir ?? null));
      if (pathname === "/api/settings") return sendJson(res, 200, buildSettingsState(ledger, opts.configPath));
      if (pathname === HOST_CONFIG_PATH) {
        // The raw file is only for the local page: it needs the token and is never served remotely.
        if (!hostConfigEnabled) return sendJson(res, 403, { error: "host config is disabled (remote mode, or not wired)" });
        if (!tokenOk(req.headers[TOKEN_HEADER])) return sendJson(res, 401, { error: "missing or invalid token" });
        return sendJson(res, 200, readHostConfig(opts.hostConfig!.configPath));
      }
      if (pathname === "/api/host") return sendJson(res, 200, buildHostStatus(ledger, opts.configPath));
      const url = new URL(req.url ?? "/", "http://localhost");
      const thread = /^\/api\/threads\/([^/]+\/[^/]+)\/(\d+)$/.exec(pathname);
      if (thread || pathname === "/api/logs") {
        const repo = thread ? thread[1]! : (url.searchParams.get("repo") ?? "");
        const issue = Number(thread ? thread[2] : url.searchParams.get("issue"));
        if (!REPO_SLUG_RE.test(repo) || !Number.isSafeInteger(issue) || issue < 1) return sendJson(res, 400, { error: "repo must be owner/name and issue a positive integer" });
        if (thread) {
          const detail = buildThreadDetail(ledger, repo, issue);
          return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: `no Thread ${repo}#${issue}` });
        }
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return sendJson(res, 200, readLogs(opts.logFile ?? null, repo, issue, Number.isFinite(limit) ? Math.min(limit, LOG_MAX) : 100));
      }
      const file = path.resolve(uiDir, "." + (pathname === "/" ? "/index.html" : pathname));
      if (!file.startsWith(uiDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      const headers = { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" };
      if (path.basename(file) === "index.html") {
        // The token only ever reaches this page: a cross-origin page cannot read the response.
        const meta = tokenEnabled ? `<meta name="archangel-token" content="${token}" />` : "";
        const html = fs.readFileSync(file, "utf8").replace("</head>", `${meta}</head>`);
        res.writeHead(200, headers).end(html);
        return;
      }
      const data = fs.readFileSync(file);
      res.writeHead(200, headers).end(data);
    } catch (err) {
      // Bodies are built before any header is written, so a failure here can still answer with an error.
      const message = err instanceof Error ? err.message : "error";
      const behind = isSchemaBehind(err);
      const status = err instanceof URIError ? 400 : behind ? 503 : 500;
      if (res.headersSent) res.destroy();
      else if ((req.url ?? "").startsWith("/api/")) sendJson(res, status, behind ? { error: SCHEMA_BEHIND, detail: message } : { error: message });
      else res.writeHead(status).end(message);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
