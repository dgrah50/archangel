import { describe, expect, it } from "bun:test";
import { DAEMON_STALE_MS, computeHealth, renderHealth } from "../src/core/status-text.js";
import { Ledger } from "../src/ledger/store.js";

const NOW = 10 * 86_400_000;

function ledger() {
  return new Ledger(":memory:", { repo: "a/b" });
}
const lock = (l: Ledger, heartbeatAt: number) => l.setSystemState("daemon_lock", JSON.stringify({ ownerId: "x", pid: 1, heartbeatAt }), NOW);
const outbox = (l: Ledger, attempts: number, lastError: string | null) =>
  (l as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } }).db
    .prepare(`INSERT INTO outbox (repo, effect_json, attempts, last_error, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run("a/b", JSON.stringify({ kind: "add_label", issueNumber: 1, label: "needs-you" }), attempts, lastError, NOW);

describe("archangel status health", () => {

  it("surfaces policy halts from the cached workflow, including an unreadable cache", () => {
    const l = ledger();
    lock(l, NOW);
    l.setSystemState("workflow:a/b", JSON.stringify({ repo: "a/b", status: "invalid", error: "bad scouts" }), NOW);
    l.setSystemState("workflow:c/d", JSON.stringify({ repo: "c/d", status: "ok" }), NOW);
    l.setSystemState("workflow:e/f", "{not json", NOW);
    const h = computeHealth(l, NOW, []);
    expect(h.halted.map((x) => `${x.repo}:${x.status}`).sort()).toEqual(["a/b:invalid", "e/f:unreadable"].sort());
    expect(renderHealth(h).join("\n")).toContain("! Policy:   a/b halted (workflow invalid): bad scouts");
  });

  it("surfaces an autonomy cap that was hit until the owner acts", () => {
    const l = ledger();
    lock(l, NOW);
    l.appendAudit("autonomy/cap_reached", null, "archangel", { steps: 8, cap: 8 }, NOW - 5, "a/b");
    const hit = computeHealth(l, NOW, ["a/b", "c/d"]);
    expect(hit.autonomyCapHit).toEqual(["a/b"]);
    expect(renderHealth(hit).join("\n")).toContain("! Autonomy: a/b hit the autonomy cap");
    l.appendAudit("thread/owner_reply", 1, "owner", {}, NOW, "a/b");
    expect(computeHealth(l, NOW, ["a/b"]).autonomyCapHit).toEqual([]);
  });
});
