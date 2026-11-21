/**
 * CRC32C (Castagnoli), the checksum Google Cloud recommends for integrity
 * checks. Node has no built-in for it: `zlib.crc32` is the other CRC-32.
 */

/** Reflected form of the Castagnoli polynomial 0x1EDC6F41. */
const POLYNOMIAL = 0x82f63b78;

const TABLE = new Uint32Array(256);
for (let byte = 0; byte < 256; byte++) {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 1 ? (crc >>> 1) ^ POLYNOMIAL : crc >>> 1;
  }
  TABLE[byte] = crc >>> 0;
}

/** CRC32C of `data` as an unsigned 32-bit integer. */
export function crc32c(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (TABLE[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The form Cloud Storage uses: the four bytes in big-endian order, base64-encoded. */
export function crc32cBase64(data: Uint8Array): string {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(crc32c(data));
  return bytes.toString("base64");
}
