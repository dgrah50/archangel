import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Ledger } from "../ledger/store.js";
import { ARCHANGEL_ROOT } from "./onboard.js";
import { buildUiState, buildWorkflowsState } from "./ui-state.js";

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

/** Serves the static bundle plus GET /api/state (JSON) from a read-only Ledger. No writes, no GitHub calls. */
export async function startUiServer(
  ledger: Ledger,
  opts: { host: string; port: number; allowRemote?: boolean; uiDir?: string },
): Promise<http.Server> {
  assertBindable(opts.host, opts.allowRemote ?? false);
  const uiDir = path.resolve(opts.uiDir ?? UI_DIST_DIR);
  if (!fs.existsSync(path.join(uiDir, "index.html"))) {
    throw new Error(`UI bundle not found at ${uiDir}. Run \`npm run build\` (or \`npm run build:ui\`) first.`);
  }
  const server = http.createServer((req, res) => {
    // Loopback-only mode also checks Host to block DNS-rebinding reads from a web page.
    const hostName = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!opts.allowRemote && !LOOPBACK.has(hostName)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" }).end("read-only");
      return;
    }
    try {
      const pathname = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      if (pathname === "/api/state") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(buildUiState(ledger)));
        return;
      }
      if (pathname === "/api/workflows") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(buildWorkflowsState(ledger)));
        return;
      }
      const file = path.resolve(uiDir, "." + (pathname === "/" ? "/index.html" : pathname));
      if (!file.startsWith(uiDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      res.end(fs.readFileSync(file));
    } catch (err) {
      res.writeHead(500).end(err instanceof Error ? err.message : "error");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
