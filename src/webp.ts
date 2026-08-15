/**
 * WebP magic + dimension parsing for catalog logos (no native deps).
 * Supports VP8 (lossy), VP8L (lossless), and VP8X extended.
 * Optional encode helpers shell out to OS `cwebp` (libwebp).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function byteAt(bytes: Uint8Array, index: number): number | undefined {
  return index >= 0 && index < bytes.length ? bytes[index] : undefined;
}

function u24le(bytes: Uint8Array, index: number): number | undefined {
  const b0 = byteAt(bytes, index);
  const b1 = byteAt(bytes, index + 1);
  const b2 = byteAt(bytes, index + 2);
  if (b0 === undefined || b1 === undefined || b2 === undefined) return undefined;
  return b0 | (b1 << 8) | (b2 << 16);
}

function u16le(bytes: Uint8Array, index: number): number | undefined {
  const b0 = byteAt(bytes, index);
  const b1 = byteAt(bytes, index + 1);
  if (b0 === undefined || b1 === undefined) return undefined;
  return b0 | (b1 << 8);
}

function u32le(bytes: Uint8Array, index: number): number | undefined {
  const b0 = byteAt(bytes, index);
  const b1 = byteAt(bytes, index + 1);
  const b2 = byteAt(bytes, index + 2);
  const b3 = byteAt(bytes, index + 3);
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined) {
    return undefined;
  }
  return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
}

export function isWebpMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    byteAt(bytes, 0) === 0x52 && // R
    byteAt(bytes, 1) === 0x49 && // I
    byteAt(bytes, 2) === 0x46 && // F
    byteAt(bytes, 3) === 0x46 && // F
    byteAt(bytes, 8) === 0x57 && // W
    byteAt(bytes, 9) === 0x45 && // E
    byteAt(bytes, 10) === 0x42 && // B
    byteAt(bytes, 11) === 0x50 // P
  );
}

/**
 * Read canvas width/height from a WebP bitstream.
 * @returns null when the file is not a parseable WebP
 */
export function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isWebpMagic(bytes) || bytes.length < 20) return null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const c0 = byteAt(bytes, offset);
    const c1 = byteAt(bytes, offset + 1);
    const c2 = byteAt(bytes, offset + 2);
    const c3 = byteAt(bytes, offset + 3);
    if (c0 === undefined || c1 === undefined || c2 === undefined || c3 === undefined) return null;
    const fourcc = String.fromCharCode(c0, c1, c2, c3);
    const chunkSize = u32le(bytes, offset + 4);
    if (chunkSize === undefined || chunkSize < 0) return null;
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > bytes.length) return null;

    if (fourcc === "VP8X" && chunkSize >= 10) {
      const wRaw = u24le(bytes, dataStart + 4);
      const hRaw = u24le(bytes, dataStart + 7);
      if (wRaw === undefined || hRaw === undefined) return null;
      return { width: wRaw + 1, height: hRaw + 1 };
    }

    if (fourcc === "VP8 " && chunkSize >= 10) {
      // Lossy: skip 3-byte frame tag + start code, then 14-bit dimensions.
      const frameTag = byteAt(bytes, dataStart);
      if (frameTag === undefined) return null;
      const keyFrame = (frameTag & 1) === 0;
      if (!keyFrame) return null;
      const start = dataStart + 3;
      if (
        start + 7 > dataEnd ||
        byteAt(bytes, start) !== 0x9d ||
        byteAt(bytes, start + 1) !== 0x01 ||
        byteAt(bytes, start + 2) !== 0x2a
      ) {
        return null;
      }
      const wh = u16le(bytes, start + 3);
      const hh = u16le(bytes, start + 5);
      if (wh === undefined || hh === undefined) return null;
      return { width: wh & 0x3fff, height: hh & 0x3fff };
    }

    if (fourcc === "VP8L" && chunkSize >= 5) {
      if (byteAt(bytes, dataStart) !== 0x2f) return null;
      const bits = u32le(bytes, dataStart + 1);
      if (bits === undefined) return null;
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }

    // Chunks are padded to even size
    offset = dataEnd + (chunkSize & 1);
  }

  return null;
}

export function resolveCwebp(): string {
  const which = spawnSync("which", ["cwebp"], { encoding: "utf8" });
  if (which.status !== 0 || !which.stdout.trim()) {
    throw new Error("cwebp not found on PATH — install libwebp (e.g. brew install webp)");
  }
  return which.stdout.trim();
}

export type EncodePngToWebpOptions = {
  quality?: number;
  /** When set, cwebp `-resize` to exact dimensions (token/provider catalog size). */
  resize?: { width: number; height: number };
};

/** Encode a PNG file to WebP bytes via cwebp (quality 85, method 6). */
export function encodePngFileToWebp(
  pngPath: string,
  qualityOrOptions: number | EncodePngToWebpOptions = 85,
): Buffer {
  const options: EncodePngToWebpOptions =
    typeof qualityOrOptions === "number" ? { quality: qualityOrOptions } : qualityOrOptions;
  const quality = options.quality ?? 85;
  const cwebp = resolveCwebp();
  const tmp = path.join(os.tmpdir(), `assets-cwebp-${process.pid}-${Date.now()}.webp`);
  try {
    const args = ["-q", String(quality), "-m", "6", "-quiet"];
    if (options.resize) {
      args.push("-resize", String(options.resize.width), String(options.resize.height));
    }
    args.push(pngPath, "-o", tmp);
    const result = spawnSync(cwebp, args, { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || `cwebp failed with status ${result.status}`);
    }
    return fs.readFileSync(tmp);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
