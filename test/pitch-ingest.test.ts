import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import sharp from "sharp";
import { ingestImage } from "../src/core/pitch-ingest.js";

const png = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: "#c33" } }).png().toBuffer();

describe("pitch image ingest", () => {
  it("accepts only clean PNG, JPEG and WebP: SVG, polyglots, oversize and over-dimension are refused", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-ingest-"));
    try {
      const good = await png(40, 30);
      const polyglot = Buffer.concat([good, Buffer.from("<script>PAYLOAD</script>")]);
      const cases: Array<[string, Buffer, RegExp | null]> = [
        ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), /PNG, JPEG or WebP/],
        ["gif", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"), /PNG, JPEG or WebP/],
        ["oversize", Buffer.concat([good, Buffer.alloc(5 * 1024 * 1024 + 1)]), /over 5242880 bytes/],
        ["over-dimension", await png(4097, 8), /dimensions/],
        ["polyglot", polyglot, null],
      ];
      for (const [name, input, refusal] of cases) {
        if (refusal) {
          await expect(ingestImage(input, dir), name).rejects.toThrow(refusal);
          continue;
        }
        const out = await ingestImage(input, dir);
        const stored = fs.readFileSync(path.join(dir, "pitch-assets", `${out.sha256}.png`));
        expect(stored.includes("PAYLOAD"), name).toBe(false);
        expect(out).toMatchObject({ mime: "image/png", width: 40, height: 30 });
      }
      expect(fs.readdirSync(path.join(dir, "pitch-assets"))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
