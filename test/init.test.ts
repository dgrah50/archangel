import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "bun:test";
import { parse as parseYaml } from "yaml";
import { HostYamlSchema } from "../src/config.js";
import { runInit } from "../src/cli/init.js";
import { Ledger } from "../src/ledger/store.js";

it("init is idempotent, never overwrites, keeps .env private, and leaves a Ledger the dashboard can audit into", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-init-"));
  const yamlPath = path.join(dir, "archangel.yaml");
  const ledgerPath = path.join(dir, ".archangel", "ledger.db");

  const first = runInit(dir, { ghUserId: () => 4242 }).join("\n");
  expect(first).toContain("created  archangel.yaml");
  expect(HostYamlSchema.parse(parseYaml(fs.readFileSync(yamlPath, "utf8"))).ownerUserId).toBe(4242);
  expect(fs.statSync(path.join(dir, ".env")).mode & 0o777).toBe(0o600);

  const ledger = new Ledger(ledgerPath, { repo: "a/b" });
  try {
    expect(ledger.listAudit({ limit: 10 }).map((e) => e.actor)).toEqual(["init"]);
    expect(ledger.autonomyCapHitSinceOwner("a/b")).toBe(false);
    ledger.appendAudit("autonomy/cap_reached", null, "archangel", {}, Date.now(), "a/b");
    expect(ledger.autonomyCapHitSinceOwner("a/b")).toBe(true);
  } finally {
    ledger.close();
  }

  fs.writeFileSync(yamlPath, "ownerUserId: 7\n");
  fs.writeFileSync(path.join(dir, ".env"), "MINE=1\n");
  const second = runInit(dir, { ghUserId: () => 4242 }).join("\n");
  expect(second).not.toContain("created");
  expect(fs.readFileSync(yamlPath, "utf8")).toBe("ownerUserId: 7\n");
  expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe("MINE=1\n");
  const again = new Ledger(ledgerPath, { readonly: true });
  try { expect(again.listAudit({ limit: 10 })).toHaveLength(2); } finally { again.close(); }
});
