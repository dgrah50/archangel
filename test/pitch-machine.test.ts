import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { PITCH_STATE_KINDS, PitchStateSchema, countsAsPromoted, isUndecided, stepPitch, type PitchEvent, type PitchState } from "../src/core/pitch-machine.js";
import { Ledger } from "../src/ledger/store.js";

const DAY = 86_400_000;
const NOW = 50 * DAY;

const S: Record<string, PitchState> = {
  open: { kind: "open" },
  partial: { kind: "partially_promoted", promotedSlices: [0], totalSlices: 3 },
  promoted: { kind: "promoted", promotedSlices: [0, 1] },
  declined: { kind: "declined", reason: null },
  expired: { kind: "expired", expiredAt: 5 },
};

describe("stepPitch: every state x event", () => {
  const legal = (s: PitchState, e: PitchEvent) => {
    const r = stepPitch(s, e);
    if (!r.ok) throw new Error(r.reject);
    return r.next;
  };

  it("promotes slices: open and partial move forward, completing every slice makes it promoted", () => {
    expect(legal(S.open!, { t: "slices_promoted", slices: [1], total: 3 })).toEqual({ kind: "partially_promoted", promotedSlices: [1], totalSlices: 3 });
    expect(legal(S.partial!, { t: "slices_promoted", slices: [2, 1], total: 3 })).toEqual({ kind: "promoted", promotedSlices: [0, 1, 2] });
    expect(legal(S.open!, { t: "slices_promoted", slices: [0], total: 1 })).toEqual({ kind: "promoted", promotedSlices: [0] });
  });

  it("closing: open is declined, a partly promoted pitch is promoted (what was promoted stays promoted)", () => {
    expect(legal(S.open!, { t: "closed" })).toEqual({ kind: "declined", reason: null });
    expect(legal(S.partial!, { t: "closed" })).toEqual({ kind: "promoted", promotedSlices: [0] });
  });

  it("expiry: open is expired, a partly promoted pitch closes as promoted", () => {
    expect(legal(S.open!, { t: "expired", at: 9 })).toEqual({ kind: "expired", expiredAt: 9 });
    expect(legal(S.partial!, { t: "expired", at: 9 })).toEqual({ kind: "promoted", promotedSlices: [0] });
  });

  it("a decline reason attaches only to a declined pitch", () => {
    expect(legal(S.declined!, { t: "decline_reason", reason: "not now" })).toEqual({ kind: "declined", reason: "not now" });
  });

  it("rejects every illegal transition", () => {
    const illegal: Array<[string, PitchEvent]> = [
      ["promoted", { t: "slices_promoted", slices: [2], total: 3 }],
      ["declined", { t: "slices_promoted", slices: [0], total: 3 }],
      ["expired", { t: "slices_promoted", slices: [0], total: 3 }],
      ["partial", { t: "slices_promoted", slices: [0], total: 3 }], // already promoted slice
      ["open", { t: "slices_promoted", slices: [], total: 3 }],
      ["open", { t: "slices_promoted", slices: [3], total: 3 }],
      ["promoted", { t: "closed" }],
      ["declined", { t: "closed" }],
      ["expired", { t: "closed" }],
      ["promoted", { t: "expired", at: 1 }],
      ["declined", { t: "expired", at: 1 }],
      ["expired", { t: "expired", at: 1 }],
      ["open", { t: "decline_reason", reason: "x" }],
      ["partial", { t: "decline_reason", reason: "x" }],
      ["promoted", { t: "decline_reason", reason: "x" }],
      ["expired", { t: "decline_reason", reason: "x" }],
    ];
    for (const [from, ev] of illegal) expect(stepPitch(S[from]!, ev).ok, `${from} + ${ev.t}`).toBe(false);
  });

  it("classifies states and validates the stored shape", () => {
    expect(PITCH_STATE_KINDS.filter((k) => isUndecided(S[k === "partially_promoted" ? "partial" : k]!))).toEqual(["open", "partially_promoted"]);
    expect(Object.values(S).filter(countsAsPromoted).map((s) => s.kind)).toEqual(["partially_promoted", "promoted"]);
    expect(PitchStateSchema.safeParse({ kind: "promoted", promotedSlices: [] }).success).toBe(false); // impossible state
    expect(PitchStateSchema.safeParse({ kind: "open", promotedSlices: [0] }).success).toBe(true); // extra keys stripped, not a second source of truth
    expect(PitchStateSchema.safeParse({ kind: "pending" }).success).toBe(false);
  });
});

function pitch(l: Ledger, n: number, filedDaysAgo = 1, hash = "h") {
  l.recordPitch({ issueNumber: n, scoutName: "pitch", trustHash: hash, title: `Pitch ${n} title long`, titleFp: `fp${n}`, contentSha256: "c", pitchJson: "{}", now: NOW - filedDaysAgo * DAY });
}

describe("a partly promoted pitch stays a live pitch (the vanishing-pitch bug)", () => {
  it("still counts toward the open cap, the digest list, expiry candidates and close detection", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    pitch(l, 1, 20);
    expect(l.markPitchSlicesPromoted(1, [0], 3, NOW)).toBe(true);
    expect(l.getPitch(1)!.state.kind).toBe("partially_promoted");
    expect(l.countOpenPitches()).toBe(1);
    expect(l.listOpenPitches().map((p) => p.issueNumber)).toEqual([1]);
    expect(l.listOpenPitchesFiledBefore(NOW - 14 * DAY).map((p) => p.issueNumber)).toEqual([1]);
    expect(l.pitchMetrics(0)).toMatchObject({ open: 1, promoted: 1 });
    // The issue still open on GitHub: close detection leaves it alone.
    expect(l.syncPitchStatuses([1], NOW)).toEqual([]);
    expect(l.getPitch(1)!.state.kind).toBe("partially_promoted");
    // Closed later: what was promoted stays promoted (never declined).
    expect(l.syncPitchStatuses([], NOW)).toEqual([]);
    expect(l.getPitch(1)!.state).toEqual({ kind: "promoted", promotedSlices: [0] });
    l.close();
  });

  it("counts as promoted for the Scout's pause rule", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    for (let n = 1; n <= 4; n++) pitch(l, n, 10 - n);
    for (const n of [1, 2, 3]) l.markPitchSlicesPromoted(n, [0], 5, NOW); // wait: promoted pitches are not "unpromoted"
    l.syncPitchStatuses([], NOW);
    expect(l.isPitchScoutPaused("pitch", "h", 4)).toBe(false);
    l.close();
  });
});

describe("illegal transitions are refused and audited", () => {
  it("cannot promote a declined or expired pitch, repeat a slice, or give an open pitch a decline reason", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    pitch(l, 1);
    pitch(l, 2);
    pitch(l, 3);
    l.syncPitchStatuses([2, 3], NOW); // #1 closed: declined
    l.markPitchExpired(2, NOW);
    expect(l.markPitchSlicesPromoted(1, [0], 2, NOW)).toBe(false); // declined
    expect(l.markPitchSlicesPromoted(2, [0], 2, NOW)).toBe(false); // expired
    expect(l.markPitchSlicesPromoted(3, [0], 2, NOW)).toBe(true);
    expect(l.markPitchSlicesPromoted(3, [0], 2, NOW)).toBe(false); // the same slice twice
    l.setPitchDeclineReason(3, "nope");
    expect(l.getPitch(1)!.state.kind).toBe("declined");
    expect(l.getPitch(2)!.state.kind).toBe("expired");
    expect(l.getPitch(3)!.state).toEqual({ kind: "partially_promoted", promotedSlices: [0], totalSlices: 2 });
    const audit = l.listAudit({ topicPrefix: "pitch/illegal_transition" }).map((a) => `${a.issueNumber}:${JSON.parse(a.payloadJson).from}:${JSON.parse(a.payloadJson).event}`).sort();
    expect(audit).toEqual(["1:declined:slices_promoted", "2:expired:slices_promoted", "3:partially_promoted:decline_reason", "3:partially_promoted:slices_promoted"]);
    expect(l.markPitchSlicesPromoted(99, [0], 1, NOW)).toBe(false); // unknown pitch
    l.close();
  });

  it("keeps the decline reason inside the declined state and feeds it to the prompt", () => {
    const l = new Ledger(":memory:", { repo: "a/b" });
    pitch(l, 1, 2);
    l.syncPitchStatuses([], NOW);
    l.setPitchDeclineReason(1, "we keep it for 2.x");
    expect(l.getPitch(1)!.state).toEqual({ kind: "declined", reason: "we keep it for 2.x" });
    expect(l.recentPitchTitles(90, NOW)[0]).toMatchObject({ declineReason: "we keep it for 2.x" });
    l.close();
  });
});

describe("migrating a Ledger with the old four-column pitch lifecycle", () => {
  it("folds status / expired_at / decline_reason / promoted_slices into one state per row and drops the old table", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-pitchmig-"));
    const file = path.join(dir, "ledger.db");
    try {
      const old = new Database(file);
      old.exec(`CREATE TABLE pitches (
        repo TEXT NOT NULL, issue_number INTEGER NOT NULL, scout_name TEXT NOT NULL, trust_hash TEXT NOT NULL, title TEXT NOT NULL,
        title_fp TEXT NOT NULL, content_sha256 TEXT NOT NULL, filed_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'declined', 'promoted')), status_at INTEGER NOT NULL,
        decline_reason TEXT, pitch_json TEXT NOT NULL DEFAULT '', promoted_slices TEXT NOT NULL DEFAULT '[]', expired_at INTEGER,
        PRIMARY KEY (repo, issue_number))`);
      const three = JSON.stringify({ slices: [{}, {}, {}] });
      const ins = old.prepare(
        `INSERT INTO pitches (repo, issue_number, scout_name, trust_hash, title, title_fp, content_sha256, filed_at, status, status_at, decline_reason, pitch_json, promoted_slices, expired_at)
         VALUES ('a/b', ?, 's', 'h', 't', 'f', 'c', 1, ?, 2, ?, ?, ?, ?)`,
      );
      ins.run(1, "open", null, three, "[]", null);
      ins.run(2, "declined", "not now", three, "[]", null);
      ins.run(3, "declined", null, three, "[]", 77); // an expired pitch
      ins.run(4, "promoted", null, three, "[0]", null); // partly promoted
      ins.run(5, "promoted", null, three, "[0,1,2]", null);
      old.close();

      const l = new Ledger(file, { repo: "a/b" });
      expect(l.getPitch(1)!.state).toEqual({ kind: "open" });
      expect(l.getPitch(2)!.state).toEqual({ kind: "declined", reason: "not now" });
      expect(l.getPitch(3)!.state).toEqual({ kind: "expired", expiredAt: 77 });
      expect(l.getPitch(4)!.state).toEqual({ kind: "partially_promoted", promotedSlices: [0], totalSlices: 3 });
      expect(l.getPitch(5)!.state).toEqual({ kind: "promoted", promotedSlices: [0, 1, 2] });
      expect(l.countOpenPitches()).toBe(2); // #1 open and #4 partly promoted
      l.close();
      const check = new Database(file, { readonly: true });
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'pitches_v1'").get()).toBeUndefined();
      check.close();
      new Ledger(file, { repo: "a/b" }).close(); // reopening is a no-op
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
