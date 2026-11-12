import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderInfo } from "../config.js";
import {
  rebuildProvidersAllJson,
  sortProviderInfo,
  toRelativePath,
  writeFormattedJson,
} from "../convert.js";
import { isMain } from "../isMain.js";

// dualNetwork for Flare (eip155-14) and Songbird (eip155-19).
//
// A provider on those chains is dualNetwork when any of these hold:
//   1. its identityAddress also appears on the other chain, or
//   2. its website domain matches a provider on the other chain and
//      domainLinked is true on both sides, or
//   3. its normalized name (lowercase, internal whitespace collapsed)
//      matches a provider on the other chain.
//
// Every other provider is false, including chains other than Flare and
// Songbird. Delegation addresses, unlinked domains, social links, and
// descriptions are not signals. Listing state is not a signal.
//
// Usage:
//   ./yarn sync:dual-network
//   ./yarn sync:dual-network --dry-run

export const FLARE_CHAIN_PATH = "eip155-14";
export const SONGBIRD_CHAIN_PATH = "eip155-19";

export type DualNetworkReason = "identity" | "linked-domain" | "name";

export interface DualNetworkProvider {
  identityAddress: string;
  name: string;
  websiteURL: string;
  domainLinked: boolean;
}

export interface DualNetworkSyncResult {
  /** Flare and Songbird providers that are dualNetwork after this rule. */
  dual: number;
  updated: number;
}

export function normalizeProviderName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

export function websiteDomain(websiteURL: string): string | null {
  try {
    const host = new URL(websiteURL).hostname.toLowerCase().replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

/** Why `provider` is dualNetwork against the other chain, or null when it is not. */
export function dualNetworkMatch(
  provider: DualNetworkProvider,
  otherChain: readonly DualNetworkProvider[],
): DualNetworkReason | null {
  const identity = provider.identityAddress.toLowerCase();
  if (otherChain.some((peer) => peer.identityAddress.toLowerCase() === identity)) {
    return "identity";
  }

  if (provider.domainLinked) {
    const domain = websiteDomain(provider.websiteURL);
    if (domain) {
      const linked = otherChain.some((peer) => {
        if (!peer.domainLinked) return false;
        return websiteDomain(peer.websiteURL) === domain;
      });
      if (linked) return "linked-domain";
    }
  }

  const name = normalizeProviderName(provider.name);
  if (name.length > 0 && otherChain.some((peer) => normalizeProviderName(peer.name) === name)) {
    return "name";
  }
  return null;
}

/** dualNetwork for one catalog entry. Chains other than Flare and Songbird are false. */
export function dualNetworkForProvider(
  chainPath: string,
  provider: DualNetworkProvider,
  flare: readonly DualNetworkProvider[],
  songbird: readonly DualNetworkProvider[],
): DualNetworkReason | null {
  if (chainPath === FLARE_CHAIN_PATH) {
    return dualNetworkMatch(provider, songbird);
  }
  if (chainPath === SONGBIRD_CHAIN_PATH) {
    return dualNetworkMatch(provider, flare);
  }
  return null;
}

export function formatDualNetworkSection(updated: number, persisted: boolean): string {
  const action = persisted ? "Updated" : "Would update";
  return ["## Dual network", "", `- ${action}: ${updated}`, ""].join("\n");
}

interface ProviderFile {
  infoPath: string;
  info: ProviderInfo;
}

function loadChainProviders(chainPath: string): ProviderFile[] {
  const chainDir = path.join(process.cwd(), "data", "providers", chainPath);
  if (!fs.existsSync(chainDir)) return [];

  const providers: ProviderFile[] = [];
  for (const entry of fs.readdirSync(chainDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const infoPath = path.join(chainDir, entry.name, "info.json");
    if (!fs.existsSync(infoPath)) continue;
    providers.push({
      infoPath,
      info: JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo,
    });
  }
  providers.sort((a, b) =>
    a.info.identityAddress.toLowerCase().localeCompare(b.info.identityAddress.toLowerCase()),
  );
  return providers;
}

function asDualNetworkProvider(info: ProviderInfo): DualNetworkProvider {
  return {
    identityAddress: info.identityAddress,
    name: typeof info.name === "string" ? info.name : "",
    websiteURL: typeof info.websiteURL === "string" ? info.websiteURL : "",
    domainLinked: info.domainLinked === true,
  };
}

function reasonDetail(reason: DualNetworkReason | null): string {
  if (reason === "identity") return " via identity address";
  if (reason === "linked-domain") return " via linked domain";
  if (reason === "name") return " via name";
  return "";
}

/** Writes dualNetwork onto every provider info.json and rebuilds all.json. */
export function syncDualNetwork(options: { dryRun?: boolean } = {}): DualNetworkSyncResult {
  const dryRun = options.dryRun === true;
  const flare = loadChainProviders(FLARE_CHAIN_PATH);
  const songbird = loadChainProviders(SONGBIRD_CHAIN_PATH);
  const flareSides = flare.map((provider) => asDualNetworkProvider(provider.info));
  const songbirdSides = songbird.map((provider) => asDualNetworkProvider(provider.info));

  const providersDir = path.join(process.cwd(), "data", "providers");
  const chains = fs
    .readdirSync(providersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let updated = 0;
  let dual = 0;

  for (const chainPath of chains) {
    let providers: ProviderFile[];
    if (chainPath === FLARE_CHAIN_PATH) {
      providers = flare;
    } else if (chainPath === SONGBIRD_CHAIN_PATH) {
      providers = songbird;
    } else {
      providers = loadChainProviders(chainPath);
    }

    let chainChanged = false;
    for (const provider of providers) {
      const reason = dualNetworkForProvider(
        chainPath,
        asDualNetworkProvider(provider.info),
        flareSides,
        songbirdSides,
      );
      const isDual = reason !== null;
      if (isDual) dual++;
      if (provider.info.dualNetwork === isDual) continue;

      const relativePath = toRelativePath(provider.infoPath);
      console.info(
        `${isDual ? "➕" : "➖"} ${provider.info.name}: dualNetwork=${isDual}${reasonDetail(reason)} (${relativePath})`,
      );
      updated++;
      if (dryRun) continue;

      provider.info.dualNetwork = isDual;
      writeFormattedJson(provider.infoPath, sortProviderInfo(provider.info));
      chainChanged = true;
    }

    if (chainChanged) {
      rebuildProvidersAllJson(chainPath);
    }
  }

  console.info(
    `\n${dryRun ? "🔍 Dry run" : "✅ Sync complete"}: ${dual} dual-network provider(s), ${updated} ${dryRun ? "would update" : "updated"}`,
  );
  return { dual, updated };
}

if (isMain(import.meta.url)) {
  try {
    syncDualNetwork({ dryRun: process.argv.includes("--dry-run") });
  } catch (error) {
    console.error("❌ Dual-network sync failed:", error);
    process.exitCode = 1;
  }
}
