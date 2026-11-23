import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

/**
 * Image ingest for pitches. Bytes come from the host (a repo file at the main SHA), never from the model. Every image is
 * sniffed, bounded, decoded and re-encoded fresh, so metadata, trailing data and polyglot payloads do not survive.
 * Anything that does not pass throws: there is no fallback and no partial store.
 */

export const INGEST_MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const INGEST_MAX_OUTPUT_BYTES = 1024 * 1024;
export const INGEST_MAX_SIDE_PX = 4096;
export const INGEST_MAX_PIXELS = 16_000_000;
export const INGEST_MAX_WIDTH = 1600;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";
const EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export interface IngestedImage {
  sha256: string;
  mime: ImageMime;
  width: number;
  height: number;
  bytes: number;
}

export const ASSET_DIR = "pitch-assets";
export const assetPath = (dataDir: string, sha256: string, mime: ImageMime): string => path.join(dataDir, ASSET_DIR, `${sha256}.${EXT[mime]}`);

function sniff(b: Buffer): ImageMime | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** `maxWidth` narrows the re-encode below the default (small images for GitHub); it can never widen it. */
export async function ingestImage(input: Buffer, dataDir: string, opts: { maxWidth?: number } = {}): Promise<IngestedImage> {
  const mime = sniff(input);
  if (!mime) throw new Error("not a PNG, JPEG or WebP image");
  if (input.length > INGEST_MAX_INPUT_BYTES) throw new Error(`image is over ${INGEST_MAX_INPUT_BYTES} bytes`);
  // The header read is the decompression-bomb guard: dimensions are checked before any pixel is decoded.
  const head = await sharp(input, { limitInputPixels: INGEST_MAX_PIXELS }).metadata();
  const { width: w, height: h } = head;
  if (!w || !h || w > INGEST_MAX_SIDE_PX || h > INGEST_MAX_SIDE_PX || w * h > INGEST_MAX_PIXELS) throw new Error("image dimensions are over the limit");
  const pipeline = sharp(input, { limitInputPixels: INGEST_MAX_PIXELS, failOn: "error" }).rotate().resize({ width: Math.min(opts.maxWidth ?? INGEST_MAX_WIDTH, INGEST_MAX_WIDTH), withoutEnlargement: true });
  const { data, info } = await (mime === "image/png" ? pipeline.png({ compressionLevel: 9 }) : mime === "image/jpeg" ? pipeline.jpeg({ quality: 80 }) : pipeline.webp({ quality: 80 })).toBuffer({ resolveWithObject: true });
  if (data.length > INGEST_MAX_OUTPUT_BYTES) throw new Error(`re-encoded image is over ${INGEST_MAX_OUTPUT_BYTES} bytes`);
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  const file = assetPath(dataDir, sha256, mime);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
  return { sha256, mime, width: info.width, height: info.height, bytes: data.length };
}
