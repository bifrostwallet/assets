import { createHash } from "node:crypto";

/** SHA-256 hex digest of logo bytes and other catalog content. */
export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
