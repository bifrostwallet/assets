import * as fs from "node:fs";
import * as path from "node:path";
import { BLOCKCHAIN_NETWORKS, type ProviderInfo } from "../config.js";
import {
  calculateHash,
  providerLogoPath,
  rebuildProvidersAllJson,
  sortProviderInfo,
} from "../convert.js";
import { parseEpochInfo } from "../fspRewards.js";
import { isMain } from "../isMain.js";
import { fetchEntityData } from "../onchain.js";
import { isValidImage, isValidName } from "../validate.js";
import { encodePngFileToWebp, isWebpMagic } from "../webp.js";

/**
 * Imports FTSO providers that are registered in the latest fsp-rewards epoch
 * but missing from data/providers/.
 *
 * Only imports identities listed in curator `PR_HINTS` (name + https logo URL).
 * Everyone else should use the self-serve listing portal. Unnamed registrants
 * are skipped and counted — use that skip count (or `./yarn check:providers`)
 * as the “registered but not yet listed here” gap. New imports always get
 * `listed: false`; listing is curator-granted later. `managementGroup` starts
 * false; run `./yarn sync:management-group` after import.
 *
 * Usage:
 *   ./yarn import:registered-providers
 *   ./yarn import:registered-providers --dry-run
 */

const FSP_REWARDS_API = "https://api.github.com/repos/flare-foundation/fsp-rewards/contents";
const FSP_REWARDS_RAW = "https://raw.githubusercontent.com/flare-foundation/fsp-rewards/main";

/**
 * Curator-only name/logo hints for rare on-chain imports (identity → metadata).
 * Prefer the listing portal for new providers. Keep empty unless you are
 * deliberately backfilling a specific identity.
 */
const PR_HINTS: Record<string, { name: string; logoURLs: string[] }> = {};

const NETWORKS = [
  { key: "flare" as const, chainPath: "eip155-14", chainId: 14 },
  { key: "songbird" as const, chainPath: "eip155-19", chainId: 19 },
];

async function fetchJSON<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "User-Agent": "assets-repo" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return (await response.json()) as T;
}

async function fetchBuffer(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, { headers: { "User-Agent": "assets-repo" } });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

async function latestEpoch(network: string) {
  const entries = await fetchJSON<{ name: string; type: string }[]>(
    `${FSP_REWARDS_API}/${network}`,
  );
  const ids = entries
    .filter((entry) => entry.type === "dir" && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);
  const epochId = ids.at(-1);
  if (epochId == null) throw new Error(`No epochs for ${network}`);
  const info = await fetchJSON(`${FSP_REWARDS_RAW}/${network}/${epochId}/reward-epoch-info.json`);
  return parseEpochInfo(info);
}

function curatedIdentities(chainPath: string): Set<string> {
  const dir = path.join(process.cwd(), "data", "providers", chainPath);
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs
      .readdirSync(dir)
      .filter((name) => name !== "all.json" && fs.existsSync(path.join(dir, name, "info.json")))
      .map((name) =>
        (
          JSON.parse(fs.readFileSync(path.join(dir, name, "info.json"), "utf8")) as ProviderInfo
        ).identityAddress.toLowerCase(),
      ),
  );
}

function resolveHint(identity: string): { name: string; logoURLs: string[] } | null {
  const hint = PR_HINTS[identity];
  if (!hint || !isValidName(hint.name)) return null;
  return hint;
}

async function writeLogo(logoPath: string, logoURLs: string[]): Promise<boolean> {
  for (const url of logoURLs) {
    const buffer = await fetchBuffer(url);
    if (!buffer) continue;
    const tmpSrc = `${logoPath}.src`;
    try {
      let webp: Buffer;
      if (isWebpMagic(buffer)) {
        webp = buffer;
      } else {
        fs.writeFileSync(tmpSrc, buffer);
        webp = encodePngFileToWebp(tmpSrc);
      }
      fs.writeFileSync(logoPath, webp);
      const validation = isValidImage(logoPath);
      if (validation.isValid) return true;
      fs.rmSync(logoPath, { force: true });
      console.warn(`⚠️ Logo rejected from ${url}: ${validation.errors.join("; ")}`);
    } catch (error) {
      fs.rmSync(logoPath, { force: true });
      console.warn(
        `⚠️ Logo convert failed from ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      fs.rmSync(tmpSrc, { force: true });
    }
  }
  return false;
}

async function importRegisteredProviders(options: { dryRun?: boolean } = {}): Promise<void> {
  const dryRun = options.dryRun === true;

  let imported = 0;
  let skippedUnknown = 0;
  let skippedLogo = 0;

  for (const network of NETWORKS) {
    const epoch = await latestEpoch(network.key);
    const existing = curatedIdentities(network.chainPath);
    const chainConfig = BLOCKCHAIN_NETWORKS[network.key];
    const missing = epoch.entities.filter((entity) => !existing.has(entity.identity));

    console.info(
      `\n=== ${network.key} epoch ${epoch.epochId}: ${missing.length} registered but missing ===`,
    );

    for (const entity of missing) {
      const hint = resolveHint(entity.identity);
      if (!hint) {
        skippedUnknown++;
        console.warn(`⏭️  Skipping unnamed ${entity.identity}`);
        continue;
      }

      const providerDir = path.join(
        process.cwd(),
        "data",
        "providers",
        network.chainPath,
        entity.identity,
      );

      if (dryRun) {
        // Probe logos without writing catalog files
        let hasLogo = false;
        for (const url of hint.logoURLs) {
          const buffer = await fetchBuffer(url);
          if (!buffer) continue;
          const tmp = path.join(process.cwd(), `.import-logo-dryrun-${entity.identity}.png`);
          fs.writeFileSync(tmp, buffer);
          const validation = isValidImage(tmp);
          fs.rmSync(tmp, { force: true });
          if (validation.isValid) {
            hasLogo = true;
            break;
          }
          console.warn(`⚠️ Logo rejected from ${url}: ${validation.errors.join("; ")}`);
        }
        if (!hasLogo) {
          skippedLogo++;
          console.warn(`⏭️  Would skip ${hint.name} (${entity.identity}): no valid logo`);
          continue;
        }
        imported++;
        console.info(`➕ Would import ${hint.name} (${entity.identity}) listed=false`);
        continue;
      }

      fs.mkdirSync(providerDir, { recursive: true });

      const logoPath = path.join(providerDir, "logo.webp");
      const hasLogo = await writeLogo(logoPath, hint.logoURLs);
      if (!hasLogo) {
        fs.rmSync(providerDir, { recursive: true, force: true });
        skippedLogo++;
        console.warn(`⏭️  Skipping ${hint.name} (${entity.identity}): no valid logo`);
        continue;
      }

      const onchain = await fetchEntityData(entity.identity, chainConfig);

      const info = sortProviderInfo({
        name: hint.name,
        description: "",
        websiteURL: "",
        links: {},
        logoURL: providerLogoPath(network.chainPath, entity.identity),
        logoHash: calculateHash(logoPath),
        identityAddress: entity.identity,
        delegationAddress: onchain.delegationAddress ?? entity.delegationAddress ?? "",
        signingPolicyAddress: onchain.signingPolicyAddress ?? entity.signingPolicyAddress ?? "",
        submitAddress: onchain.submitAddress ?? entity.submitAddress ?? "",
        submitSignaturesAddress:
          onchain.submitSignaturesAddress ?? entity.submitSignaturesAddress ?? "",
        publicKey: onchain.publicKey ?? "",
        validators: onchain.validators ?? [],
        listed: false,
        managementGroup: false,
        domainLinked: false,
        dualNetwork: false,
      });

      fs.writeFileSync(path.join(providerDir, "info.json"), `${JSON.stringify(info, null, 2)}\n`);
      imported++;
      console.info(`➕ ${hint.name} (${entity.identity}) listed=false`);
    }

    if (!dryRun) {
      rebuildProvidersAllJson(network.chainPath);
    }
  }

  console.info(
    `\n${dryRun ? "🔍 Dry run —" : "✅"} Imported ${imported}; skipped unnamed=${skippedUnknown} (registered, no name/logo yet), bad/missing logo=${skippedLogo}`,
  );
  if (!dryRun && imported > 0) {
    console.warn(
      "⚠️ New entries have no signatures.json yet (advisory until REQUIRE_PROVIDER_SIGNATURES=1).",
    );
  }
}

if (isMain(import.meta.url)) {
  importRegisteredProviders({ dryRun: process.argv.includes("--dry-run") }).catch((error) => {
    console.error("❌ Import failed:", error);
    process.exitCode = 1;
  });
}

export default importRegisteredProviders;
