import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildUiState } from "../src/core/ui-state.js";
import { Ledger } from "../src/ledger/store.js";
import { Dashboard } from "../ui/src/Dashboard.js";

const NOW = 10 * 86_400_000;
const EVIL = "<script>alert(1)</script>";

describe("Dashboard", () => {
  it("renders an untrusted <script> title as text, links to GitHub, and has no controls", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    const t = l.upsertThread({ issueNumber: 1, title: EVIL, bodySha256: "s", now: NOW - 3_600_000 });
    l.transition(1, t.version, { kind: "needs_you", code: "review_vetoed", reason: "x", resumeTo: { kind: "queued" } } as never, { now: NOW - 3_600_000 });
    const html = renderToStaticMarkup(createElement(ChakraProvider, { value: defaultSystem, children: createElement(Dashboard, { state: buildUiState(l, NOW) }) }));
    expect(html).not.toContain(EVIL);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('href="https://github.com/a/b/issues/1"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });
});
