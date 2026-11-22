import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { BROKER_SENTINEL, TokenBroker, brokerPreflight, type BrokerAdapter } from "../src/compute/token-broker.js";

describe("token broker", () => {
  it("a failed refresh writes the sentinel into the secret and preflight then refuses the Attempt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archangel-broker-"));
    try {
      const secrets = new Map<string, string>();
      let fail = false;
      const adapter: BrokerAdapter = {
        id: "codex",
        secretName: "S",
        refresh: async () => {
          if (fail) throw new Error("invalid_grant");
          return { accessToken: "real-token", expiresAt: Date.now() + 3_600_000, accountId: "acct" };
        },
      };
      const broker = new TokenBroker(adapter, dir, async (n, v) => void secrets.set(n, v));

      expect(await broker.refreshOnce()).toBeGreaterThan(0);
      expect(secrets.get("S")).toBe("real-token");
      expect(brokerPreflight(dir, "codex", 20 * 60_000).accountId).toBe("acct");
      expect(() => brokerPreflight(dir, "codex", 2 * 3_600_000)).toThrow(/expires too soon/);

      fail = true;
      expect(await broker.refreshOnce()).toBeNull();
      expect(secrets.get("S")).toBe(BROKER_SENTINEL);
      expect(() => brokerPreflight(dir, "codex", 1000)).toThrow(/refusing to start the Attempt/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
