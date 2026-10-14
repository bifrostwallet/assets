import * as fs from "node:fs";
import * as path from "node:path";
import { createPublicClient, http } from "viem";
import { BLOCKCHAIN_NETWORKS, FLARE_CONTRACT_REGISTRY, type ProviderInfo } from "../config.js";
import { rebuildProvidersAllJson, sortProviderInfo, toRelativePath } from "../convert.js";
import { isMain } from "../isMain.js";
import type { HexString } from "../validate.js";
import { strongBrandKeys, weakBrandKeys } from "./syncDualNetwork.js";

// On-chain FTSO Management Group membership (FIP.02 / STP.03) sync.
// Resolves PollingManagementGroup through Flare's fixed ContractRegistry and reads the
// current member list (identity/voter addresses). Approach adapted from the MIT-licensed
// BurstLabs/flareregistry (src/lib/management-group.ts).
//
// The group exists on Flare mainnet only. eip155-14 providers get true/false
// from membership directly. A Songbird (eip155-19) entry mirrors its Flare
// counterpart's membership when the entry is a curator-approved dual-network
// brand (dualNetwork: true) and any brand key links it to a member — the
// curator already approved the cross-chain pairing, so weak keys (name, links)
// may identify the counterpart, but never grant membership without that
// dualNetwork gate. Every other chain is forced to false.

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

/** Reads the current Management Group member addresses (lowercased identity addresses) */
export async function fetchManagementGroupMembers(): Promise<string[]> {
  const flare = BLOCKCHAIN_NETWORKS.flare;
  const client = createPublicClient({
    transport: http(flare.rpc, { timeout: 30000, retryCount: 3, retryDelay: 1000 }),
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
  members: number;
  updated: number;
  unknownMembers: string[];
}

function loadChainInfos(providersDir: string, chainPath: string): ProviderInfo[] {
  const chainDir = path.join(providersDir, chainPath);
  if (!fs.existsSync(chainDir)) return [];
  const infos: ProviderInfo[] = [];
  for (const provider of fs.readdirSync(chainDir, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    const infoPath = path.join(chainDir, provider.name, "info.json");
    if (!fs.existsSync(infoPath)) continue;
    infos.push(JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo);
  }
  return infos;
}

/**
 * Brand keys of Flare MG members — a curator-approved dual-network Songbird
 * entry sharing any of these mirrors the brand's Flare membership.
 */
function memberBrandKeys(providersDir: string, memberSet: Set<string>): Set<string> {
  const keys = new Set<string>();
  for (const info of loadChainInfos(providersDir, BLOCKCHAIN_NETWORKS.flare.path)) {
    if (!memberSet.has(info.identityAddress.toLowerCase())) continue;
    for (const { key } of [...strongBrandKeys(info), ...weakBrandKeys(info)]) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Writes managementGroup onto every provider info.json and rebuilds all.json.
 * Also reports MG members that have no curated provider entry (gap audit).
 */
export async function syncManagementGroup(): Promise<ManagementGroupSyncResult> {
  const members = await fetchManagementGroupMembers();
  const memberSet = new Set(members);
  console.info(`📡 Management Group members on Flare: ${members.length}`);

  const providersDir = path.join(process.cwd(), "data", "providers");
  const memberKeys = memberBrandKeys(providersDir, memberSet);
  const knownIdentities = new Set<string>();
  let updated = 0;

  for (const chain of fs.readdirSync(providersDir, { withFileTypes: true })) {
    if (!chain.isDirectory()) continue;
    const chainDir = path.join(providersDir, chain.name);
    const isFlare = chain.name === BLOCKCHAIN_NETWORKS.flare.path;
    const isSongbird = chain.name === BLOCKCHAIN_NETWORKS.songbird.path;
    let chainChanged = false;

    for (const provider of fs.readdirSync(chainDir, { withFileTypes: true })) {
      if (!provider.isDirectory()) continue;
      const infoPath = path.join(chainDir, provider.name, "info.json");
      if (!fs.existsSync(infoPath)) continue;

      const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
      const identity = info.identityAddress.toLowerCase();
      if (isFlare) {
        knownIdentities.add(identity);
      }

      const isMember = isFlare
        ? memberSet.has(identity)
        : isSongbird &&
          info.dualNetwork === true &&
          [...strongBrandKeys(info), ...weakBrandKeys(info)].some(({ key }) => memberKeys.has(key));
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

  const unknownMembers = members.filter((member) => !knownIdentities.has(member));

  console.info(`\n✅ Sync complete: ${updated} provider(s) updated`);
  if (unknownMembers.length > 0) {
    console.warn(
      `\n⚠️ ${unknownMembers.length} Management Group member(s) missing from data/providers/eip155-14:`,
    );
    for (const member of unknownMembers) {
      console.warn(`   ${member}`);
    }
  }

  return { members: members.length, updated, unknownMembers };
}

if (isMain(import.meta.url)) {
  syncManagementGroup().catch((error) => {
    console.error("❌ Management Group sync failed:", error);
    process.exitCode = 1;
  });
}
