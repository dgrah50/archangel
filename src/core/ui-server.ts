import http from "node:http";
import type { Ledger } from "../ledger/store.js";
import { renderPage } from "./ui-page.js";
import { buildUiState } from "./ui-state.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertBindable(host: string, allowRemote: boolean): void {
  if (!allowRemote && !LOOPBACK.has(host)) {
    throw new Error(`Refusing to bind the read-only UI to non-loopback host ${host}; pass --allow-remote to override.`);
  }
}

/** Serves GET / (HTML) and GET /api/state (JSON) from a read-only Ledger. Nothing else, no writes, no GitHub calls. */
export async function startUiServer(
  ledger: Ledger,
  opts: { host: string; port: number; allowRemote?: boolean },
): Promise<http.Server> {
  assertBindable(opts.host, opts.allowRemote ?? false);
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
    const url = (req.url ?? "/").split("?")[0];
    try {
      if (url === "/api/state") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(buildUiState(ledger)));
      } else if (url === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(renderPage(buildUiState(ledger)));
      } else {
        res.writeHead(404).end("not found");
      }
    } catch (err) {
      res.writeHead(500).end(err instanceof Error ? err.message : "error");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
