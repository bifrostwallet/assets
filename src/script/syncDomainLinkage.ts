import * as fs from "node:fs";
import * as path from "node:path";
import { BLOCKCHAIN_NETWORKS, type ProviderInfo } from "../config.js";
import {
  rebuildProvidersAllJson,
  sortProviderInfo,
  toRelativePath,
  writeFormattedJson,
} from "../convert.js";
import {
  type DomainLinkageCheck,
  isInconclusiveDomainLinkage,
  verifyProviderDomainLinkage,
} from "../domainLinkage.js";
import { isMain } from "../isMain.js";

/**
 * Writes unsigned `domainLinked` onto every curated provider from a live
 * well-known / DNS check against their websiteURL. Safe for signatures
 * (field is in UNSIGNED_PROVIDER_INFO_KEYS).
 *
 * A check that never completes (timeout, connect error, DNS timeout) leaves
 * the stored flag unchanged. HTTP non-2xx, an empty allowlist, or a
 * contradiction updates it.
 *
 * Usage:
 *   ./yarn sync:domain-linkage
 *   ./yarn sync:domain-linkage --dry-run
 */

/**
 * Value to write, or `undefined` when the file should stay as it is.
 * Transport-only failures do not seed or clear the stored flag.
 */
export function domainLinkedValueToStore(
  stored: boolean | undefined,
  result: DomainLinkageCheck,
): boolean | undefined {
  if (isInconclusiveDomainLinkage(result)) return undefined;
  const missing = typeof stored !== "boolean";
  if (stored === result.linked && !missing) return undefined;
  return result.linked;
}

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

      const stored = typeof info.domainLinked === "boolean" ? info.domainLinked : undefined;
      const next = domainLinkedValueToStore(stored, result);
      // Skip no-ops and transport failures. Still write a definitive value when
      // the field is absent so catalogs stay complete.
      if (next === undefined) {
        if (isInconclusiveDomainLinkage(result) && stored !== false) {
          console.info(
            `⏭️  ${network.path} ${info.name}: domain linkage check did not complete, keeping domainLinked unchanged (${toRelativePath(infoPath)})`,
          );
        }
        continue;
      }

      const missingField = stored === undefined;
      console.info(
        `${next ? "➕" : "➖"} ${network.path} ${info.name}: domainLinked=${next}${dryRun ? " (dry-run)" : ""}${missingField && !next ? " (seed)" : ""} (${toRelativePath(infoPath)})`,
      );

      if (dryRun) {
        updated++;
        continue;
      }

      info.domainLinked = next;
      writeFormattedJson(infoPath, sortProviderInfo(info));
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
