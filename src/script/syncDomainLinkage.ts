import * as fs from "node:fs";
import * as path from "node:path";
import { BLOCKCHAIN_NETWORKS, type ProviderInfo } from "../config.js";
import { rebuildProvidersAllJson, sortProviderInfo, toRelativePath } from "../convert.js";
import { verifyProviderDomainLinkage } from "../domainLinkage.js";
import { isMain } from "../isMain.js";

/**
 * Writes unsigned `domainLinked` onto every curated provider from a live
 * well-known / DNS check against their websiteURL. Safe for signatures
 * (field is in UNSIGNED_PROVIDER_INFO_KEYS).
 *
 * Usage:
 *   ./yarn sync:domain-linkage
 *   ./yarn sync:domain-linkage --dry-run
 */

export interface DomainLinkageSyncResult {
  checked: number;
  linked: number;
  updated: number;
}

export async function syncDomainLinkage(options: {
  dryRun?: boolean;
}): Promise<DomainLinkageSyncResult> {
  const dryRun = options.dryRun === true;
  const networks = Object.values(BLOCKCHAIN_NETWORKS).filter((network) => network.entityManager);

  let checked = 0;
  let linked = 0;
  let updated = 0;

  for (const network of networks) {
    const chainDir = path.join(process.cwd(), "data", "providers", network.path);
    if (!fs.existsSync(chainDir)) continue;

    let chainChanged = false;
    const identities = fs
      .readdirSync(chainDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const identity of identities) {
      const infoPath = path.join(chainDir, identity, "info.json");
      if (!fs.existsSync(infoPath)) continue;

      const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
      checked++;

      const result = await verifyProviderDomainLinkage({
        chainPath: network.path,
        identityAddress: info.identityAddress,
        websiteURL: info.websiteURL ?? "",
      });

      if (result.linked) linked++;

      const current = info.domainLinked === true;
      const missingField = typeof info.domainLinked !== "boolean";
      // Skip no-ops; still write once when the field is absent so catalogs stay complete
      if (current === result.linked && !missingField) {
        continue;
      }

      console.info(
        `${result.linked ? "➕" : "➖"} ${network.path} ${info.name}: domainLinked=${result.linked}${dryRun ? " (dry-run)" : ""}${missingField && !result.linked ? " (seed)" : ""} (${toRelativePath(infoPath)})`,
      );

      if (dryRun) {
        updated++;
        continue;
      }

      info.domainLinked = result.linked;
      fs.writeFileSync(infoPath, `${JSON.stringify(sortProviderInfo(info), null, 2)}\n`);
      updated++;
      chainChanged = true;
    }

    if (chainChanged) {
      rebuildProvidersAllJson(network.path);
    }
  }

  console.info(
    `\n✅ Domain linkage sync: ${checked} checked, ${linked} linked, ${updated} ${dryRun ? "would update" : "updated"}`,
  );
  return { checked, linked, updated };
}

if (isMain(import.meta.url)) {
  const dryRun = process.argv.includes("--dry-run");
  syncDomainLinkage({ dryRun }).catch((error) => {
    console.error("❌ Domain linkage sync failed:", error);
    process.exitCode = 1;
  });
}
