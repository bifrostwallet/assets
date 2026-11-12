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
// A provider on those chains is dualNetwork when either:
//   1. its identityAddress also appears on the other chain, or
//   2. its website domain matches a provider on the other chain and
//      domainLinked is true on both sides.
//
// data/providers/dual-network-grandfathered.json is a frozen snapshot of
// identity addresses that were already dualNetwork, listed on both chains,
// and shared a normalized name (lowercase, internal whitespace collapsed)
// when the snapshot was taken. Those addresses stay true. The snapshot is
// not recomputed: a later name-only match is not added, and a later delist
// does not remove an address. selectGrandfatheredIdentities documents that
// one-time choice. This script only reads the file.
//
// Every other provider is false, including chains other than Flare and
// Songbird. Delegation addresses, unlinked domains, social links, and
// descriptions are not signals.
//
// Usage:
//   ./yarn sync:dual-network
//   ./yarn sync:dual-network --dry-run

export const FLARE_CHAIN_PATH = "eip155-14";
export const SONGBIRD_CHAIN_PATH = "eip155-19";

/** Frozen grandfather snapshot, relative to the repo root. */
export const DUAL_NETWORK_GRANDFATHERED_FILE = path.join(
  "data",
  "providers",
  "dual-network-grandfathered.json",
);

const IDENTITY_ADDRESS = /^0x[0-9a-f]{40}$/;

export type DualNetworkReason = "identity" | "linked-domain" | "grandfathered";

export interface DualNetworkProvider {
  identityAddress: string;
  websiteURL: string;
  domainLinked: boolean;
}

export interface GrandfatherSource {
  identityAddress: string;
  name: string;
  listed: boolean;
  dualNetwork: boolean;
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

/**
 * Identities to freeze as dualNetwork. This is the rule that produced
 * dual-network-grandfathered.json. Sync does not call it.
 * An entry qualifies when it is already dualNetwork and listed, and the other
 * chain has the same normalized name on a listed provider.
 */
export function selectGrandfatheredIdentities(
  flare: readonly GrandfatherSource[],
  songbird: readonly GrandfatherSource[],
): string[] {
  const flareListedNames = listedNames(flare);
  const songbirdListedNames = listedNames(songbird);
  const selected = new Set<string>();
  for (const provider of flare) {
    if (isGrandfatherSource(provider, songbirdListedNames)) {
      selected.add(provider.identityAddress.toLowerCase());
    }
  }
  for (const provider of songbird) {
    if (isGrandfatherSource(provider, flareListedNames)) {
      selected.add(provider.identityAddress.toLowerCase());
    }
  }
  return [...selected].sort();
}

function listedNames(providers: readonly GrandfatherSource[]): Set<string> {
  const names = new Set<string>();
  for (const provider of providers) {
    if (!provider.listed) continue;
    const name = normalizeProviderName(provider.name);
    if (name.length > 0) names.add(name);
  }
  return names;
}

function isGrandfatherSource(
  provider: GrandfatherSource,
  otherListedNames: ReadonlySet<string>,
): boolean {
  if (!provider.dualNetwork || !provider.listed) return false;
  const name = normalizeProviderName(provider.name);
  if (name.length === 0) return false;
  return otherListedNames.has(name);
}

export function readGrandfatheredIdentities(filePath: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read dual-network grandfather snapshot ${filePath}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || !("identities" in parsed)) {
    throw new Error(`${filePath}: expected { identities: string[] }`);
  }
  const identities = (parsed as { identities: unknown }).identities;
  if (!Array.isArray(identities)) {
    throw new Error(`${filePath}: identities must be an array`);
  }

  const grandfathered = new Set<string>();
  for (const identity of identities) {
    if (typeof identity !== "string") {
      throw new Error(`${filePath}: identities must be strings`);
    }
    const normalized = identity.toLowerCase();
    if (!IDENTITY_ADDRESS.test(normalized)) {
      throw new Error(`${filePath}: invalid identity address ${identity}`);
    }
    if (grandfathered.has(normalized)) {
      throw new Error(`${filePath}: duplicate identity ${normalized}`);
    }
    grandfathered.add(normalized);
  }
  return grandfathered;
}

/** Why `provider` is dualNetwork against the other chain, or null when it is not. */
export function dualNetworkMatch(
  provider: DualNetworkProvider,
  otherChain: readonly DualNetworkProvider[],
  grandfathered: ReadonlySet<string>,
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

  if (grandfathered.has(identity)) return "grandfathered";
  return null;
}

/**
 * dualNetwork for one catalog entry. Chains other than Flare and Songbird
 * are false, including identities in the grandfather snapshot.
 */
export function dualNetworkForProvider(
  chainPath: string,
  provider: DualNetworkProvider,
  flare: readonly DualNetworkProvider[],
  songbird: readonly DualNetworkProvider[],
  grandfathered: ReadonlySet<string>,
): DualNetworkReason | null {
  if (chainPath === FLARE_CHAIN_PATH) {
    return dualNetworkMatch(provider, songbird, grandfathered);
  }
  if (chainPath === SONGBIRD_CHAIN_PATH) {
    return dualNetworkMatch(provider, flare, grandfathered);
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
    websiteURL: typeof info.websiteURL === "string" ? info.websiteURL : "",
    domainLinked: info.domainLinked === true,
  };
}

function reasonDetail(reason: DualNetworkReason | null): string {
  if (reason === "identity") return " via identity address";
  if (reason === "linked-domain") return " via linked domain";
  if (reason === "grandfathered") return " via grandfathered snapshot";
  return "";
}

/** Writes dualNetwork onto every provider info.json and rebuilds all.json. */
export function syncDualNetwork(options: { dryRun?: boolean } = {}): DualNetworkSyncResult {
  const dryRun = options.dryRun === true;
  const grandfathered = readGrandfatheredIdentities(
    path.join(process.cwd(), DUAL_NETWORK_GRANDFATHERED_FILE),
  );

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
        grandfathered,
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
