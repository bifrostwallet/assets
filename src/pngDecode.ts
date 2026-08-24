// Minimal PNG → RGBA decoder for catalog logos (non-interlaced).
// Supports color types 0/2/3/4/6 and bit depths 1/2/4/8. Used by normalize:catalog-logos.

import { inflateSync } from "node:zlib";

export type DecodedPng = {
  width: number;
  height: number;
  rgba: Uint8Array;
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readByte(bytes: Uint8Array, index: number): number {
  const value = bytes[index];
  if (value === undefined) throw new Error("Truncated PNG data");
  return value;
}

function unfilter(
  filter: number,
  row: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const x = readByte(row, i);
    const a = i >= bpp ? readByte(out, i - bpp) : 0;
    const b = prev ? readByte(prev, i) : 0;
    const c = prev && i >= bpp ? readByte(prev, i - bpp) : 0;
    let value: number;
    switch (filter) {
      case 0:
        value = x;
        break;
      case 1:
        value = (x + a) & 0xff;
        break;
      case 2:
        value = (x + b) & 0xff;
        break;
      case 3:
        value = (x + Math.floor((a + b) / 2)) & 0xff;
        break;
      case 4:
        value = (x + paeth(a, b, c)) & 0xff;
        break;
      default:
        throw new Error(`Unsupported PNG filter ${filter}`);
    }
    out[i] = value;
  }
  return out;
}

function bitsPerPixel(colorType: number, bitDepth: number): number {
  let channels = 4;
  if (colorType === 0 || colorType === 3) channels = 1;
  else if (colorType === 2) channels = 3;
  else if (colorType === 4) channels = 2;
  return channels * bitDepth;
}

function readPackedSample(row: Uint8Array, bitDepth: number, index: number): number {
  const samplesPerByte = 8 / bitDepth;
  const byteIndex = Math.floor(index / samplesPerByte);
  const shift = bitDepth * (samplesPerByte - 1 - (index % samplesPerByte));
  const mask = (1 << bitDepth) - 1;
  return (readByte(row, byteIndex) >> shift) & mask;
}

/**
 * Decode a PNG buffer to straight RGBA (alpha 0–255).
 */
export function decodePngToRgba(bytes: Buffer): DecodedPng {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    throw new Error("Not a PNG");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts: Buffer[] = [];
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = readByte(data, 8);
      colorType = readByte(data, 9);
      interlace = readByte(data, 12);
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "tRNS") {
      trns = Buffer.from(data);
    } else if (type === "IDAT") {
      idatParts.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (!width || !height) throw new Error("Missing IHDR");
  if (![1, 2, 4, 8].includes(bitDepth)) {
    throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
  }
  if (interlace !== 0) throw new Error("Interlaced PNG is not supported");
  if (![0, 2, 3, 4, 6].includes(colorType)) {
    throw new Error(`Unsupported PNG color type ${colorType}`);
  }
  if (bitDepth < 8 && colorType !== 0 && colorType !== 3) {
    throw new Error(`Bit depth ${bitDepth} only supported for greyscale/indexed PNG`);
  }
  if ((colorType === 4 || colorType === 6 || colorType === 2) && bitDepth !== 8) {
    throw new Error(`Color type ${colorType} requires 8-bit depth`);
  }

  const inflated = inflateSync(Buffer.concat(idatParts));
  const bppBytes = Math.max(1, Math.ceil(bitsPerPixel(colorType, bitDepth) / 8));
  const stride = Math.ceil((width * bitsPerPixel(colorType, bitDepth)) / 8);

  const rows: Uint8Array[] = [];
  let prev: Uint8Array | null = null;
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = readByte(inflated, src++);
    const row = inflated.subarray(src, src + stride);
    src += stride;
    const decoded = unfilter(filter, row, prev, bppBytes);
    rows.push(decoded);
    prev = decoded;
  }

  const rgba = new Uint8Array(width * height * 4);
  let out = 0;
  const maxSample = (1 << bitDepth) - 1;
  const scale8 = (sample: number) =>
    bitDepth === 8 ? sample : Math.round((sample * 255) / maxSample);

  for (let y = 0; y < height; y++) {
    const row = rows[y];
    if (!row) throw new Error("Truncated PNG data");
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (colorType === 0) {
        const sample = bitDepth === 8 ? readByte(row, x) : readPackedSample(row, bitDepth, x);
        r = g = b = scale8(sample);
        if (trns && trns.length >= 2) {
          const key = bitDepth === 8 ? sample : sample;
          const trnsValue =
            bitDepth === 8 ? readByte(trns, 1) : (readByte(trns, 0) << 8) | readByte(trns, 1);
          if (key === trnsValue || (bitDepth < 8 && sample === trns[1])) a = 0;
        }
      } else if (colorType === 2) {
        const i = x * 3;
        r = readByte(row, i);
        g = readByte(row, i + 1);
        b = readByte(row, i + 2);
        if (trns && trns.length >= 6) {
          if (r === trns[1] && g === trns[3] && b === trns[5]) a = 0;
        }
      } else if (colorType === 3) {
        if (!palette) throw new Error("Indexed PNG missing PLTE");
        const index = bitDepth === 8 ? readByte(row, x) : readPackedSample(row, bitDepth, x);
        r = readByte(palette, index * 3);
        g = readByte(palette, index * 3 + 1);
        b = readByte(palette, index * 3 + 2);
        if (trns && index < trns.length) a = readByte(trns, index);
      } else if (colorType === 4) {
        const i = x * 2;
        r = g = b = readByte(row, i);
        a = readByte(row, i + 1);
      } else {
        const i = x * 4;
        r = readByte(row, i);
        g = readByte(row, i + 1);
        b = readByte(row, i + 2);
        a = readByte(row, i + 3);
      }
      rgba[out++] = r;
      rgba[out++] = g;
      rgba[out++] = b;
      rgba[out++] = a;
    }
  }

  return { width, height, rgba };
}
