import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderInfo } from "../config.js";
import { providerLogoPath, rebuildAllProvidersAllJson, sortProviderInfo } from "../convert.js";
import { isMain } from "../isMain.js";

const ADDRESS_FIELDS = [
  "identityAddress",
  "delegationAddress",
  "signingPolicyAddress",
  "submitAddress",
  "submitSignaturesAddress",
] as const;

/**
 * Normalizes every provider info.json to the current schema (idempotent):
 * - EVM addresses + publicKey forced to lowercase (canonical in-repo form)
 * - logoURL becomes a relative path (providers/<chain>/<identity>/logo.webp)
 * - listed defaults to false (seeded once from the previously hardcoded allowlists)
 * - managementGroup defaults to false (kept current by sync:management-group)
 * - domainLinked defaults to false (kept current by sync:domain-linkage / nightly refresh)
 * Then rebuilds all.json for every chain.
 */

/** Providers previously hardcoded as listed in src/config.ts */
const SEED_LISTED: Record<string, string[]> = {
  "eip155-14": ["0x1650d2760baee638c034200dedcbe17b050d0364"],
  "eip155-19": ["0x7429e0c70306834e2b210cf3feb306342f456ce7"],
};

function normalizeProviders(): void {
  const providersDir = path.join(process.cwd(), "data", "providers");
  let updated = 0;
  let unchanged = 0;

  for (const chain of fs.readdirSync(providersDir, { withFileTypes: true })) {
    if (!chain.isDirectory()) continue;
    const chainDir = path.join(providersDir, chain.name);

    for (const provider of fs.readdirSync(chainDir, { withFileTypes: true })) {
      if (!provider.isDirectory()) continue;
      const infoPath = path.join(chainDir, provider.name, "info.json");
      if (!fs.existsSync(infoPath)) continue;

      const before = fs.readFileSync(infoPath, "utf8");
      const info = JSON.parse(before) as ProviderInfo;

      for (const key of ADDRESS_FIELDS) {
        const value = info[key];
        if (typeof value === "string" && value) {
          info[key] = value.toLowerCase();
        }
      }
      if (typeof info.publicKey === "string" && info.publicKey) {
        info.publicKey = info.publicKey.toLowerCase();
      }

      info.logoURL = providerLogoPath(chain.name, info.identityAddress);

      if (typeof info.listed !== "boolean") {
        info.listed = (SEED_LISTED[chain.name] ?? []).includes(info.identityAddress);
      }

      if (typeof info.managementGroup !== "boolean") {
        info.managementGroup = false;
      }

      if (typeof info.dualNetwork !== "boolean") {
        info.dualNetwork = false;
      }

      if (typeof info.domainLinked !== "boolean") {
        info.domainLinked = false;
      }

      const after = `${JSON.stringify(sortProviderInfo(info), null, 2)}\n`;
      if (after !== before) {
        fs.writeFileSync(infoPath, after);
        updated++;
      } else {
        unchanged++;
      }
    }
  }

  rebuildAllProvidersAllJson();
  console.info(`✅ Normalized providers: ${updated} updated, ${unchanged} unchanged`);
  console.info("✅ Rebuilt all.json for every provider chain");
}

if (isMain(import.meta.url)) {
  normalizeProviders();
}

export default normalizeProviders;
