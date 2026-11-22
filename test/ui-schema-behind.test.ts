import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_BEHIND, startUiServer } from "../src/core/ui-server.js";
import { buildUiState, isSchemaBehind } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";
import { AppView } from "../ui/src/AppView.js";
import { FeedError, SCHEMA_BEHIND as UI_CODE, SCHEMA_BEHIND_MESSAGE, fetchFeed, isUiState } from "../ui/src/payload.js";

const NOW = 10 * 86_400_000;
const none = { data: null, at: null, error: null };

/** A real Ledger file whose schema is behind: `drop` tables are removed after the daemon "created" it. */
function behindLedger(drop: string[]): Ledger {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arc-behind-")), "ledger.db");
  new Ledger(file).close();
  const raw = new Database(file);
  for (const t of drop) raw.exec(`DROP TABLE ${t}`);
  raw.close();
  return new Ledger(file, { readonly: true });
}

describe("a Ledger the daemon has not migrated", () => {
  it("recognises the SQLite errors", () => {
    expect(isSchemaBehind(new Error("no such table: health_faults"))).toBe(true);
    expect(isSchemaBehind(new Error("no such column: state"))).toBe(true);
    expect(isSchemaBehind(new Error("corrupt row"))).toBe(false);
    expect(UI_CODE).toBe(SCHEMA_BEHIND);
  });

  it("a missing health_faults table fails only the Faults section, not the whole state", () => {
    const s = buildUiState(behindLedger(["health_faults"]), NOW);
    expect(s.faults).toBeNull();
    expect(s.needsYou).toEqual([]);
    expect(s.daily).toHaveLength(14);
  });

  it("the server answers 503 ledger_schema_behind for a read of a missing table, and 200 where only faults is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-ui-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head></html>");
    const start = (l: Ledger) => startUiServer(l, { host: "127.0.0.1", port: 0, uiDir: dir });
    const faultsOnly = await start(behindLedger(["health_faults"]));
    const scouts = await start(behindLedger(["scout_proposals"]));
    try {
      const url = (s: typeof faultsOnly) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      expect((await fetch(`${url(faultsOnly)}/api/state`)).status).toBe(200);
      const res = await fetch(`${url(scouts)}/api/state`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; detail: string };
      expect(body.error).toBe(SCHEMA_BEHIND);
      expect(body.detail).toContain("no such table");
    } finally {
      faultsOnly.close();
      scouts.close();
    }
  });
});

describe("the shell says what to do", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("fetchFeed turns the 503 into a FeedError with the restart message and code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: SCHEMA_BEHIND, detail: "no such table: x" }), { status: 503 })));
    const err = (await fetchFeed("/api/state", isUiState).catch((e: unknown) => e)) as FeedError;
    expect(err).toBeInstanceOf(FeedError);
    expect(err.code).toBe(SCHEMA_BEHIND);
    expect(err.message).toContain(SCHEMA_BEHIND_MESSAGE);
    expect(err.message).toContain("no such table: x");
  });
  it("renders the restart state instead of the generic cannot-load alert", () => {
    const out = renderToStaticMarkup(
      createElement(ChakraProvider, { value: defaultSystem, children: createElement(AppView, { route: { page: "overview" }, state: { data: null, at: null, error: `/api/state: ${SCHEMA_BEHIND_MESSAGE}`, code: SCHEMA_BEHIND }, workflows: none, evals: none, settings: none, host: none, thread: none, logs: none, now: NOW, onRetry: () => {} } as never) }),
    );
    expect(out).toContain("The Ledger schema is behind.");
    expect(out).toContain("Restart the daemon");
    expect(out).not.toContain("Cannot load the dashboard.");
  });
});
