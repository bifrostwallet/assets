// Catalog logo raster helpers — keep flatten/quantize algorithm in sync with
// assets-intake apps/add/src/lib/logoConvert.ts (median-cut palette, white flatten,
// cover-fit 128×128). Final published form is WebP (cwebp / portal encode);
// rasterizeRgbaToCatalogPng remains for intermediate / tooling use.
// Node differences: zlib.deflateSync instead of CompressionStream; rasterize from
// decoded RGBA (bilinear) instead of canvas drawImage.

import { deflateSync } from "node:zlib";
import { PROVIDER_LOGO_REQUIREMENTS } from "./config.js";
import { isWebpMagic, readWebpDimensions } from "./webp.js";

export const LOGO_FLATTEN_BACKGROUND = { r: 255, g: 255, b: 255 } as const;
export const LOGO_PALETTE_COLORS = 256;

const SIZE = PROVIDER_LOGO_REQUIREMENTS.WIDTH;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export type Rgb = { r: number; g: number; b: number };

export type LogoConvertResult = { ok: true; bytes: Buffer } | { ok: false; errors: string[] };

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32be(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const len = u32be(data.length);
  const body = concatBytes([typeBytes, data]);
  const crc = u32be(crc32(body));
  return concatBytes([len, body, crc]);
}

function colorKey(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

function boxAverage(pixels: Rgb[]): Rgb {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const pixel of pixels) {
    r += pixel.r;
    g += pixel.g;
    b += pixel.b;
  }
  const n = pixels.length || 1;
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

function boxRange(pixels: Rgb[]): { channel: "r" | "g" | "b"; min: number; max: number } {
  let minR = 255;
  let minG = 255;
  let minB = 255;
  let maxR = 0;
  let maxG = 0;
  let maxB = 0;
  for (const pixel of pixels) {
    if (pixel.r < minR) minR = pixel.r;
    if (pixel.g < minG) minG = pixel.g;
    if (pixel.b < minB) minB = pixel.b;
    if (pixel.r > maxR) maxR = pixel.r;
    if (pixel.g > maxG) maxG = pixel.g;
    if (pixel.b > maxB) maxB = pixel.b;
  }
  const rangeR = maxR - minR;
  const rangeG = maxG - minG;
  const rangeB = maxB - minB;
  if (rangeR >= rangeG && rangeR >= rangeB) return { channel: "r", min: minR, max: maxR };
  if (rangeG >= rangeR && rangeG >= rangeB) return { channel: "g", min: minG, max: maxG };
  return { channel: "b", min: minB, max: maxB };
}

/**
 * Median-cut palette (no dither). If unique colors ≤ maxColors, keep them exact.
 * Same algorithm as assets-intake logoConvert.ts.
 */
export function quantizeToPalette(
  rgba: Uint8ClampedArray | Uint8Array,
  maxColors: number = LOGO_PALETTE_COLORS,
): { palette: Rgb[]; indices: Uint8Array } {
  const pixelCount = rgba.length / 4;
  const pixels: Rgb[] = new Array(pixelCount);
  const unique = new Map<number, Rgb>();

  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    const pixel = { r, g, b };
    pixels[p] = pixel;
    unique.set(colorKey(r, g, b), pixel);
  }

  let palette: Rgb[];
  if (unique.size <= maxColors) {
    palette = [...unique.values()];
  } else {
    const boxes: Rgb[][] = [[...pixels]];
    while (boxes.length < maxColors) {
      let splitIndex = -1;
      let bestSpan = -1;
      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i]!;
        if (box.length < 2) continue;
        const { min, max } = boxRange(box);
        const span = max - min;
        if (span > bestSpan) {
          bestSpan = span;
          splitIndex = i;
        }
      }
      if (splitIndex < 0 || bestSpan <= 0) break;

      const box = boxes[splitIndex]!;
      const { channel } = boxRange(box);
      box.sort((a, b) => a[channel] - b[channel]);
      const mid = box.length >> 1;
      boxes.splice(splitIndex, 1, box.slice(0, mid), box.slice(mid));
    }
    palette = boxes.map(boxAverage);
  }

  const indexByColor = new Map<number, number>();
  for (let i = 0; i < palette.length; i++) {
    const color = palette[i]!;
    indexByColor.set(colorKey(color.r, color.g, color.b), i);
  }

  const indices = new Uint8Array(pixelCount);
  for (let p = 0; p < pixelCount; p++) {
    const pixel = pixels[p]!;
    const key = colorKey(pixel.r, pixel.g, pixel.b);
    const exact = indexByColor.get(key);
    if (exact !== undefined) {
      indices[p] = exact;
      continue;
    }
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < palette.length; i++) {
      const color = palette[i]!;
      const dr = pixel.r - color.r;
      const dg = pixel.g - color.g;
      const db = pixel.b - color.b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
        if (dist === 0) break;
      }
    }
    indices[p] = best;
  }

  return { palette, indices };
}

/** Encode opaque indexed PNG (color type 3) — no tRNS / alpha. */
export function encodeIndexedPng(
  width: number,
  height: number,
  palette: Rgb[],
  indices: Uint8Array,
): Buffer {
  if (palette.length === 0 || palette.length > 256) {
    throw new Error("Palette must have 1–256 colors");
  }
  if (indices.length !== width * height) {
    throw new Error("Index buffer size mismatch");
  }

  const plte = new Uint8Array(palette.length * 3);
  for (let i = 0; i < palette.length; i++) {
    const color = palette[i]!;
    plte[i * 3] = color.r;
    plte[i * 3 + 1] = color.g;
    plte[i * 3 + 2] = color.b;
  }

  const raw = new Uint8Array((width + 1) * height);
  let src = 0;
  let dst = 0;
  for (let y = 0; y < height; y++) {
    raw[dst++] = 0; // filter None
    for (let x = 0; x < width; x++) {
      raw[dst++] = indices[src++]!;
    }
  }

  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(width), 0);
  ihdr.set(u32be(height), 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed color
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = deflateSync(Buffer.from(raw));
  return Buffer.from(
    concatBytes([
      new Uint8Array(PNG_MAGIC),
      pngChunk("IHDR", ihdr),
      pngChunk("PLTE", plte),
      pngChunk("IDAT", compressed),
      pngChunk("IEND", new Uint8Array(0)),
    ]),
  );
}

function sampleBilinear(src: Uint8Array, srcW: number, srcH: number, x: number, y: number): Rgb {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, srcW - 1);
  const y1 = Math.min(y0 + 1, srcH - 1);
  const fx = x - x0;
  const fy = y - y0;

  const idx = (px: number, py: number) => (py * srcW + px) * 4;
  const i00 = idx(x0, y0);
  const i10 = idx(x1, y0);
  const i01 = idx(x0, y1);
  const i11 = idx(x1, y1);

  const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
  const r = mix(mix(src[i00]!, src[i10]!, fx), mix(src[i01]!, src[i11]!, fx), fy);
  const g = mix(mix(src[i00 + 1]!, src[i10 + 1]!, fx), mix(src[i01 + 1]!, src[i11 + 1]!, fx), fy);
  const b = mix(mix(src[i00 + 2]!, src[i10 + 2]!, fx), mix(src[i01 + 2]!, src[i11 + 2]!, fx), fy);
  const a = mix(mix(src[i00 + 3]!, src[i10 + 3]!, fx), mix(src[i01 + 3]!, src[i11 + 3]!, fx), fy);

  // Flatten onto white (same as portal fillStyle #ffffff before drawImage)
  const alpha = a / 255;
  return {
    r: Math.round(r * alpha + LOGO_FLATTEN_BACKGROUND.r * (1 - alpha)),
    g: Math.round(g * alpha + LOGO_FLATTEN_BACKGROUND.g * (1 - alpha)),
    b: Math.round(b * alpha + LOGO_FLATTEN_BACKGROUND.b * (1 - alpha)),
  };
}

/**
 * Cover-fit source RGBA into SIZE×SIZE on white, quantize to ≤256 colors, return indexed PNG.
 * Rejects sources smaller than SIZE×SIZE (same rule as the listing portal).
 */
export function rasterizeRgbaToCatalogPng(src: Uint8Array, srcW: number, srcH: number): Buffer {
  if (srcW < SIZE || srcH < SIZE) {
    throw new Error(`Image must be at least ${SIZE}×${SIZE}px (got ${srcW}×${srcH}px)`);
  }

  const scale = Math.max(SIZE / srcW, SIZE / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const dx = (SIZE - drawW) / 2;
  const dy = (SIZE - drawH) / 2;

  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sx = (x - dx) / scale;
      const sy = (y - dy) / scale;
      const out = (y * SIZE + x) * 4;
      if (sx < 0 || sy < 0 || sx >= srcW || sy >= srcH) {
        rgba[out] = LOGO_FLATTEN_BACKGROUND.r;
        rgba[out + 1] = LOGO_FLATTEN_BACKGROUND.g;
        rgba[out + 2] = LOGO_FLATTEN_BACKGROUND.b;
        rgba[out + 3] = 255;
        continue;
      }
      const pixel = sampleBilinear(src, srcW, srcH, sx, sy);
      rgba[out] = pixel.r;
      rgba[out + 1] = pixel.g;
      rgba[out + 2] = pixel.b;
      rgba[out + 3] = 255;
    }
  }

  const { palette, indices } = quantizeToPalette(rgba, LOGO_PALETTE_COLORS);
  return encodeIndexedPng(SIZE, SIZE, palette, indices);
}

/** Final catalog form: opaque 128×128 WebP ≤24KB (assets git + intake). */
export function validateCatalogLogo(bytes: Uint8Array): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const sizeKB = bytes.length / 1024;
  if (sizeKB > PROVIDER_LOGO_REQUIREMENTS.MAX_SIZE_KB) {
    errors.push(
      `File is ${sizeKB.toFixed(1)}KB - maximum is ${PROVIDER_LOGO_REQUIREMENTS.MAX_SIZE_KB}KB`,
    );
  }
  if (!isWebpMagic(bytes)) {
    return { valid: false, errors: ["File is not a valid WebP"] };
  }
  const dims = readWebpDimensions(bytes);
  if (!dims) {
    return { valid: false, errors: ["Could not parse WebP dimensions"] };
  }
  if (dims.width !== SIZE || dims.height !== SIZE) {
    errors.push(`Image must be exactly ${SIZE}×${SIZE}px, got ${dims.width}x${dims.height}px`);
  }
  return { valid: errors.length === 0, errors };
}
