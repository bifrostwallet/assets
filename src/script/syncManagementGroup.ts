import * as fs from "node:fs";
import * as path from "node:path";
import { BLOCKCHAIN_NETWORKS, type NetworkConfig, type ProviderInfo } from "../config.js";
import { rebuildProvidersAllJson, sortProviderInfo, writeFormattedJson } from "../convert.js";
import { isMain } from "../isMain.js";
import { fetchManagementGroupMembers } from "../onchain.js";

// On-chain FTSO Management Group membership (FIP.02 / STP.03) sync.
// Resolves PollingManagementGroup through the network's ContractRegistry and reads the
// current member list (identity/voter addresses). Approach adapted from the MIT-licensed
// BurstLabs/flareregistry (src/lib/management-group.ts).
//
// Flare and Songbird each have their own PollingManagementGroup. The registry
// address is the same on both networks; the RPC selects the chain. A provider
// is a member only when its identity address is on that network's list.
// Every other chain is forced to false. Members with no catalog entry are
// reported and are not created.

const MANAGEMENT_GROUP_NETWORKS = [BLOCKCHAIN_NETWORKS.flare, BLOCKCHAIN_NETWORKS.songbird];

export interface ManagementGroupFlip {
  chainPath: string;
  identityAddress: string;
  name: string;
  infoPath: string;
  catalog: boolean;
  chain: boolean;
}

export interface ManagementGroupUnknown {
  label: string;
  chainPath: string;
  members: string[];
}

export interface ManagementGroupDrift {
  flips: ManagementGroupFlip[];
  unknown: ManagementGroupUnknown[];
  flareMembers: number;
  songbirdMembers: number;
}

export interface ManagementGroupSyncResult {
  flareMembers: number;
  songbirdMembers: number;
  updated: number;
  unknownFlareMembers: string[];
  unknownSongbirdMembers: string[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Compare catalog managementGroup flags with PollingManagementGroup.
 * Does not write. A failed member read throws.
 * On-chain members with no info.json are returned in `unknown` and are not created.
 */
export async function collectManagementGroupDrift(options?: {
  readMembers?: (network: NetworkConfig) => Promise<readonly string[]>;
}): Promise<ManagementGroupDrift> {
  const readMembers = options?.readMembers ?? fetchManagementGroupMembers;
  const membersByPath = new Map<string, Set<string>>();
  const counts = new Map<string, number>();

  for (const network of MANAGEMENT_GROUP_NETWORKS) {
    let members: string[];
    try {
      members = (await readMembers(network)).map((address) => address.toLowerCase());
    } catch (error) {
      throw new Error(
        `Management Group member read failed on ${network.name} (${network.path}): ${errorText(error)}`,
        { cause: error },
      );
    }
    membersByPath.set(network.path, new Set(members));
    counts.set(network.path, members.length);
  }

  const providersDir = path.join(process.cwd(), "data", "providers");
  const knownByPath = new Map<string, Set<string>>();
  const flips: ManagementGroupFlip[] = [];

  if (fs.existsSync(providersDir)) {
    for (const chain of fs.readdirSync(providersDir, { withFileTypes: true })) {
      if (!chain.isDirectory()) continue;
      const chainDir = path.join(providersDir, chain.name);

      for (const provider of fs.readdirSync(chainDir, { withFileTypes: true })) {
        if (!provider.isDirectory()) continue;
        const infoPath = path.join(chainDir, provider.name, "info.json");
        if (!fs.existsSync(infoPath)) continue;

        const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
        const identity = info.identityAddress.toLowerCase();
        const memberSet = membersByPath.get(chain.name);
        if (memberSet) {
          const known = knownByPath.get(chain.name) ?? new Set<string>();
          known.add(identity);
          knownByPath.set(chain.name, known);
        }

        const isMember = memberSet?.has(identity) ?? false;
        const catalog = info.managementGroup === true;
        if (catalog === isMember) continue;
        flips.push({
          chainPath: chain.name,
          identityAddress: identity,
          name: info.name,
          infoPath,
          catalog,
          chain: isMember,
        });
      }
    }
  }

  flips.sort((a, b) => {
    const chainOrder = a.chainPath.localeCompare(b.chainPath);
    if (chainOrder !== 0) return chainOrder;
    return a.identityAddress.localeCompare(b.identityAddress);
  });

  const unknown: ManagementGroupUnknown[] = [];
  for (const network of MANAGEMENT_GROUP_NETWORKS) {
    const memberSet = membersByPath.get(network.path) ?? new Set<string>();
    const known = knownByPath.get(network.path) ?? new Set<string>();
    const members = [...memberSet].filter((member) => !known.has(member)).sort();
    if (members.length === 0) continue;
    unknown.push({ label: network.name, chainPath: network.path, members });
  }

  return {
    flips,
    unknown,
    flareMembers: counts.get(BLOCKCHAIN_NETWORKS.flare.path) ?? 0,
    songbirdMembers: counts.get(BLOCKCHAIN_NETWORKS.songbird.path) ?? 0,
  };
}

/** Write managementGroup flips into info.json and rebuild affected all.json files. */
export function applyManagementGroupDrift(drift: ManagementGroupDrift): number {
  const chainsTouched = new Set<string>();
  let updated = 0;

  for (const flip of drift.flips) {
    if (!fs.existsSync(flip.infoPath)) continue;
    const info = JSON.parse(fs.readFileSync(flip.infoPath, "utf8")) as ProviderInfo;
    info.managementGroup = flip.chain;
    writeFormattedJson(flip.infoPath, sortProviderInfo(info));
    chainsTouched.add(flip.chainPath);
    updated += 1;
  }

  for (const chainPath of chainsTouched) {
    rebuildProvidersAllJson(chainPath);
  }

  return updated;
}

/** Warning lines for on-chain members that have no catalog entry. */
export function unknownManagementGroupWarningLines(drift: ManagementGroupDrift): string[] {
  const lines: string[] = [];
  for (const group of drift.unknown) {
    if (group.members.length === 0) continue;
    lines.push(
      `Warning: ${group.members.length} ${group.label} Management Group member(s) have no catalog entry under data/providers/${group.chainPath} and were not added.`,
    );
    for (const member of group.members) {
      lines.push(`- \`${member}\``);
    }
  }
  return lines;
}

export function warnUnknownManagementGroupMembers(drift: ManagementGroupDrift): void {
  for (const line of unknownManagementGroupWarningLines(drift)) {
    console.warn(line);
  }
}

export function formatManagementGroupSummary(
  drift: ManagementGroupDrift,
  options?: { skipped?: boolean },
): string {
  if (options?.skipped) {
    return "Management Group comparison was skipped.\n";
  }

  const lines: string[] = [];
  if (drift.flips.length === 0) {
    lines.push("No provider managementGroup flags differ from PollingManagementGroup.");
  } else {
    lines.push(
      "Management Group — PollingManagementGroup membership differs from info.json.",
      "",
      "Merging applies these flags. Signatures stay valid because managementGroup is unsigned.",
      "",
    );
    for (const flip of drift.flips) {
      lines.push(`- **${flip.name}** (\`${flip.identityAddress}\`, ${flip.chainPath})`);
      lines.push(`  - \`managementGroup\`: \`${flip.catalog}\` → \`${flip.chain}\``);
    }
  }

  const warnings = unknownManagementGroupWarningLines(drift);
  if (warnings.length > 0) {
    lines.push("");
    lines.push(...warnings);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Writes managementGroup onto every provider info.json and rebuilds all.json.
 * Also reports MG members that have no curated provider entry (gap audit).
 */
export async function syncManagementGroup(): Promise<ManagementGroupSyncResult> {
  const drift = await collectManagementGroupDrift();
  console.info(`📡 Management Group members on Flare: ${drift.flareMembers}`);
  console.info(`📡 Management Group members on Songbird: ${drift.songbirdMembers}`);
  console.info(`\n${formatManagementGroupSummary(drift)}`);
  warnUnknownManagementGroupMembers(drift);

  const updated = applyManagementGroupDrift(drift);
  console.info(`\n✅ Sync complete: ${updated} provider(s) updated`);

  const unknownFlareMembers =
    drift.unknown.find((group) => group.chainPath === BLOCKCHAIN_NETWORKS.flare.path)?.members ??
    [];
  const unknownSongbirdMembers =
    drift.unknown.find((group) => group.chainPath === BLOCKCHAIN_NETWORKS.songbird.path)?.members ??
    [];

  return {
    flareMembers: drift.flareMembers,
    songbirdMembers: drift.songbirdMembers,
    updated,
    unknownFlareMembers,
    unknownSongbirdMembers,
  };
}

if (isMain(import.meta.url)) {
  syncManagementGroup().catch((error) => {
    console.error("❌ Management Group sync failed:", error);
    process.exitCode = 1;
  });
}
