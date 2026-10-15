import * as fs from "node:fs";
import * as path from "node:path";
import { createPublicClient, http } from "viem";
import {
  BLOCKCHAIN_NETWORKS,
  FLARE_CONTRACT_REGISTRY,
  type NetworkConfig,
  type ProviderInfo,
} from "../config.js";
import { rebuildProvidersAllJson, sortProviderInfo, toRelativePath } from "../convert.js";
import { isMain } from "../isMain.js";
import type { HexString } from "../validate.js";

// On-chain FTSO Management Group membership (FIP.02 / STP.03) sync.
// Resolves PollingManagementGroup through the network's ContractRegistry and reads the
// current member list (identity/voter addresses). Approach adapted from the MIT-licensed
// BurstLabs/flareregistry (src/lib/management-group.ts).
//
// Flare and Songbird each have their own PollingManagementGroup. The registry
// address is the same on both networks; the RPC selects the chain. A provider
// is a member only when its identity address is on that network's list.
// Every other chain is forced to false.

const registryAbi = [
  {
    type: "function",
    name: "getContractAddressByName",
    stateMutability: "view",
    inputs: [{ type: "string" }],
    outputs: [{ type: "address" }],
  },
] as const;

const managementGroupAbi = [
  {
    type: "function",
    name: "getManagementGroupMembers",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
] as const;

/** Reads one network's Management Group member addresses (lowercased identity addresses). */
export async function fetchManagementGroupMembers(network: NetworkConfig): Promise<string[]> {
  const client = createPublicClient({
    transport: http(network.rpc, { timeout: 30000, retryCount: 3, retryDelay: 1000 }),
  });

  const managementGroupAddress = (await client.readContract({
    address: FLARE_CONTRACT_REGISTRY as HexString,
    abi: registryAbi,
    functionName: "getContractAddressByName",
    args: ["PollingManagementGroup"],
  })) as HexString;

  const members = (await client.readContract({
    address: managementGroupAddress,
    abi: managementGroupAbi,
    functionName: "getManagementGroupMembers",
  })) as readonly HexString[];

  return members.map((address) => address.toLowerCase());
}

export interface ManagementGroupSyncResult {
  flareMembers: number;
  songbirdMembers: number;
  updated: number;
  unknownFlareMembers: string[];
  unknownSongbirdMembers: string[];
}

/**
 * Writes managementGroup onto every provider info.json and rebuilds all.json.
 * Also reports MG members that have no curated provider entry (gap audit).
 */
export async function syncManagementGroup(): Promise<ManagementGroupSyncResult> {
  const flareMembers = await fetchManagementGroupMembers(BLOCKCHAIN_NETWORKS.flare);
  const songbirdMembers = await fetchManagementGroupMembers(BLOCKCHAIN_NETWORKS.songbird);
  const membersByPath = new Map<string, Set<string>>([
    [BLOCKCHAIN_NETWORKS.flare.path, new Set(flareMembers)],
    [BLOCKCHAIN_NETWORKS.songbird.path, new Set(songbirdMembers)],
  ]);
  console.info(`📡 Management Group members on Flare: ${flareMembers.length}`);
  console.info(`📡 Management Group members on Songbird: ${songbirdMembers.length}`);

  const providersDir = path.join(process.cwd(), "data", "providers");
  const knownByPath = new Map<string, Set<string>>();
  let updated = 0;

  for (const chain of fs.readdirSync(providersDir, { withFileTypes: true })) {
    if (!chain.isDirectory()) continue;
    const chainDir = path.join(providersDir, chain.name);
    let chainChanged = false;

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
      if (info.managementGroup !== isMember) {
        info.managementGroup = isMember;
        fs.writeFileSync(infoPath, `${JSON.stringify(sortProviderInfo(info), null, 2)}\n`);
        console.info(
          `${isMember ? "➕" : "➖"} ${info.name}: managementGroup=${isMember} (${toRelativePath(infoPath)})`,
        );
        updated++;
        chainChanged = true;
      }
    }

    if (chainChanged) {
      rebuildProvidersAllJson(chain.name);
    }
  }

  const unknownFlareMembers = flareMembers.filter(
    (member) => !knownByPath.get(BLOCKCHAIN_NETWORKS.flare.path)?.has(member),
  );
  const unknownSongbirdMembers = songbirdMembers.filter(
    (member) => !knownByPath.get(BLOCKCHAIN_NETWORKS.songbird.path)?.has(member),
  );

  console.info(`\n✅ Sync complete: ${updated} provider(s) updated`);
  for (const [label, chainPath, unknown] of [
    ["Flare", BLOCKCHAIN_NETWORKS.flare.path, unknownFlareMembers],
    ["Songbird", BLOCKCHAIN_NETWORKS.songbird.path, unknownSongbirdMembers],
  ] as const) {
    if (unknown.length === 0) continue;
    console.warn(
      `\n⚠️ ${unknown.length} ${label} Management Group member(s) missing from data/providers/${chainPath}:`,
    );
    for (const member of unknown) {
      console.warn(`   ${member}`);
    }
  }

  return {
    flareMembers: flareMembers.length,
    songbirdMembers: songbirdMembers.length,
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
