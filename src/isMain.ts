import path from "node:path";
import { fileURLToPath } from "node:url";

/** True when this module is the process entrypoint (ESM replacement for require.main). */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(importMetaUrl) === path.resolve(entry);
}
