/**
 * One-shot: convert every provider logo.png → logo.webp (cwebp), update
 * logoURL + logoHash, delete PNG, rebuild all.json.
 *
 * Requires OS `cwebp` (libwebp). Invalidates signatures — re-sign after.
 *
 * Usage:
 *   ./yarn migrate:catalog-logos-webp --dry-run
 *   ./yarn migrate:catalog-logos-webp
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderInfo } from "../config.js";
import {
  calculateHash,
  providerLogoPath,
  rebuildAllProvidersAllJson,
  sortProviderInfo,
} from "../convert.js";
import { isMain } from "../isMain.js";
import { validateCatalogLogo } from "../logoConvert.js";
import { encodePngFileToWebp, resolveCwebp } from "../webp.js";

function listProviderDirs(): { chainPath: string; identity: string; dir: string }[] {
  const root = path.join(process.cwd(), "data", "providers");
  const out: { chainPath: string; identity: string; dir: string }[] = [];
  for (const chain of fs.readdirSync(root, { withFileTypes: true })) {
    if (!chain.isDirectory() || !chain.name.startsWith("eip155-")) continue;
    const chainDir = path.join(root, chain.name);
    for (const entry of fs.readdirSync(chainDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("0x")) continue;
      const dir = path.join(chainDir, entry.name);
      if (!fs.existsSync(path.join(dir, "info.json"))) continue;
      out.push({ chainPath: chain.name, identity: entry.name, dir });
    }
  }
  return out.sort((a, b) =>
    a.chainPath === b.chainPath
      ? a.identity.localeCompare(b.identity)
      : a.chainPath.localeCompare(b.chainPath),
  );
}

async function migrateCatalogLogosWebp(options: { dryRun?: boolean } = {}): Promise<void> {
  const dryRun = options.dryRun === true;
  resolveCwebp();
  const providers = listProviderDirs();

  let converted = 0;
  let alreadyWebp = 0;
  let failed = 0;
  let missing = 0;

  for (const { chainPath, identity, dir } of providers) {
    const relative = `data/providers/${chainPath}/${identity}`;
    const pngPath = path.join(dir, "logo.png");
    const webpPath = path.join(dir, "logo.webp");
    const infoPath = path.join(dir, "info.json");
    const expectedUrl = providerLogoPath(chainPath, identity);

    try {
      if (fs.existsSync(webpPath) && !fs.existsSync(pngPath)) {
        const existing = fs.readFileSync(webpPath);
        const validation = validateCatalogLogo(existing);
        if (!validation.valid) {
          failed++;
          console.warn(
            `❌ ${relative}: existing logo.webp invalid — ${validation.errors.join("; ")}`,
          );
          continue;
        }
        if (!dryRun) {
          const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
          const hash = calculateHash(webpPath);
          if (info.logoHash !== hash || info.logoURL !== expectedUrl) {
            info.logoHash = hash;
            info.logoURL = expectedUrl;
            fs.writeFileSync(infoPath, `${JSON.stringify(sortProviderInfo(info), null, 2)}\n`);
          }
        }
        alreadyWebp++;
        continue;
      }

      if (!fs.existsSync(pngPath)) {
        missing++;
        console.warn(`❌ ${relative}: no logo.png or logo.webp`);
        continue;
      }

      const next = encodePngFileToWebp(pngPath);
      const validation = validateCatalogLogo(next);
      if (!validation.valid) {
        failed++;
        console.warn(`❌ ${relative}: converted but invalid — ${validation.errors.join("; ")}`);
        continue;
      }

      if (dryRun) {
        converted++;
        console.info(
          `🔄 Would convert ${relative} (${fs.statSync(pngPath).size} → ${next.length} bytes)`,
        );
        continue;
      }

      fs.writeFileSync(webpPath, next);
      fs.unlinkSync(pngPath);
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
      info.logoHash = calculateHash(webpPath);
      info.logoURL = expectedUrl;
      fs.writeFileSync(infoPath, `${JSON.stringify(sortProviderInfo(info), null, 2)}\n`);
      converted++;
      console.info(
        `✅ ${relative} → ${next.length} bytes, logoHash=${info.logoHash.slice(0, 12)}…`,
      );
    } catch (error) {
      failed++;
      console.warn(`❌ ${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!dryRun && converted > 0) {
    rebuildAllProvidersAllJson();
  }

  console.info(
    `\n${dryRun ? "🔍 Dry run —" : "✅"} ${converted} converted, ${alreadyWebp} already WebP, ${missing} missing, ${failed} failed (of ${providers.length})`,
  );
  if (converted > 0) {
    console.warn("⚠️ logoHash changes invalidate signatures — re-sign after this pass.");
  }
  if (failed > 0 || missing > 0) {
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  migrateCatalogLogosWebp({ dryRun: process.argv.includes("--dry-run") }).catch((error) => {
    console.error("❌ migrate:catalog-logos-webp failed:", error);
    process.exitCode = 1;
  });
}

export default migrateCatalogLogosWebp;
