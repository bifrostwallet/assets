/**
 * Ensure every provider logo is final-form catalog WebP (128×128, ≤24KB).
 * Delegates to migrate:catalog-logos-webp (PNG→WebP via cwebp when needed).
 *
 * Usage:
 *   ./yarn normalize:catalog-logos --dry-run
 *   ./yarn normalize:catalog-logos
 */

import { isMain } from "../isMain.js";
import migrateCatalogLogosWebp from "./migrateCatalogLogosWebp.js";

if (isMain(import.meta.url)) {
  migrateCatalogLogosWebp({ dryRun: process.argv.includes("--dry-run") }).catch((error) => {
    console.error("❌ normalize:catalog-logos failed:", error);
    process.exitCode = 1;
  });
}

export default migrateCatalogLogosWebp;
