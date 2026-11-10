import { createPublicClient, http, type PublicClient } from "viem";
import {
  type BlockchainNetworkConfig,
  FLARE_CONTRACT_REGISTRY,
  type ProviderInfo,
} from "./config.js";
import { encodeNodeID } from "./convert.js";
import { type HexString, isValidNodeID } from "./validate.js";

interface VoterAddresses {
  submitAddress: HexString;
  submitSignaturesAddress: HexString;
  signingPolicyAddress: HexString;
}

/**
 * Transient RPC retries for EntityManager and PollingManagementGroup reads.
 * A read that still fails must abort the nightly refresh, not skip the field.
 */
export const CHAIN_RPC_RETRY_COUNT = 3;
export const CHAIN_RPC_RETRY_DELAY_MS = 1000;

const entityManagerAbi = [
  {
    type: "function",
    name: "getDelegationAddressOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "getVoterAddresses",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "submitAddress", type: "address" },
          { name: "submitSignaturesAddress", type: "address" },
          { name: "signingPolicyAddress", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getPublicKeyOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bytes32" }, { type: "bytes32" }],
  },
  {
    type: "function",
    name: "getNodeIdsOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bytes20[]" }],
  },
] as const;

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

export interface ContractReadArgs {
  address: HexString;
  abi: readonly object[];
  functionName: string;
  args?: readonly unknown[];
}

/** Narrow chain client so tests can mock contract reads without a live RPC. */
export interface ChainContractReader {
  readContract(args: ContractReadArgs): Promise<unknown>;
}

export interface FetchEntityDataOptions {
  log?: boolean;
  /**
   * When true, a failed EntityManager read throws. The nightly refresh uses
   * this so a dropped getNodeIdsOf (or any other field read) fails the run
   * instead of leaving the field unset, which chain drift would then skip.
   * Interactive provider add keeps the default and logs a missing field.
   */
  strict?: boolean;
  /**
   * Also read PollingManagementGroup membership for this identity. Intake
   * ingest sets this so managementGroup comes from chain.
   */
  includeManagementGroup?: boolean;
  client?: ChainContractReader;
  readManagementGroupMembers?: (network: BlockchainNetworkConfig) => Promise<readonly string[]>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asReader(client: PublicClient): ChainContractReader {
  return {
    readContract: (args) => client.readContract(args as never) as Promise<unknown>,
  };
}

export function createNetworkClient(network: BlockchainNetworkConfig): PublicClient {
  return createPublicClient({
    chain: {
      id: network.chain,
      name: network.name,
      network: network.name.toLowerCase(),
      nativeCurrency: { name: network.name, symbol: network.symbol, decimals: 18 },
      rpcUrls: { default: { http: [network.rpc] } },
    },
    transport: http(network.rpc, {
      timeout: 30000,
      retryCount: CHAIN_RPC_RETRY_COUNT,
      retryDelay: CHAIN_RPC_RETRY_DELAY_MS,
    }),
  });
}

async function readField<T>(
  client: ChainContractReader,
  strict: boolean,
  log: (message: string) => void,
  functionName: string,
  missingLog: string,
  args: ContractReadArgs,
): Promise<T | undefined> {
  try {
    return (await client.readContract(args)) as T;
  } catch (error) {
    if (strict) {
      throw new Error(`${functionName} failed: ${errorText(error)}`, { cause: error });
    }
    log(missingLog);
    return undefined;
  }
}

/**
 * Reads one network's Management Group member addresses (lowercased identity addresses).
 * The HTTP transport retries transient RPC failures. A read that still fails throws.
 */
export async function fetchManagementGroupMembers(
  network: BlockchainNetworkConfig,
  options: { client?: ChainContractReader } = {},
): Promise<string[]> {
  const client = options.client ?? asReader(createNetworkClient(network));

  try {
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
  } catch (error) {
    throw new Error(
      `PollingManagementGroup read failed on ${network.name} (${network.path}): ${errorText(error)}`,
      { cause: error },
    );
  }
}

/**
 * Fetches a provider's on-chain entity data from the EntityManager:
 * delegation, submit, submit-signatures and signing-policy addresses,
 * public key, and validator NodeIDs. With includeManagementGroup, also sets
 * managementGroup from that network's PollingManagementGroup member list.
 */
export async function fetchEntityData(
  identityAddress: string,
  network: BlockchainNetworkConfig,
  options: FetchEntityDataOptions = {},
): Promise<Partial<ProviderInfo>> {
  const log = options.log ? console.info : () => {};
  const strict = options.strict === true;
  const client = options.client ?? asReader(createNetworkClient(network));
  const entityManager = network.entityManager as HexString;
  const identity = identityAddress.toLowerCase() as HexString;

  const result: Partial<ProviderInfo> = { identityAddress: identity };
  log(`✅ Identity Address: ${identity}`);

  const delegationAddress = await readField<HexString>(
    client,
    strict,
    log,
    "getDelegationAddressOf",
    "❌ Delegation Address: Missing",
    {
      address: entityManager,
      abi: entityManagerAbi,
      functionName: "getDelegationAddressOf",
      args: [identity],
    },
  );
  if (delegationAddress) {
    result.delegationAddress = delegationAddress.toLowerCase() as HexString;
    log(`✅ Delegation Address: ${result.delegationAddress}`);
  }

  const voterAddresses = await readField<VoterAddresses>(
    client,
    strict,
    log,
    "getVoterAddresses",
    "❌ Voter Addresses: Missing",
    {
      address: entityManager,
      abi: entityManagerAbi,
      functionName: "getVoterAddresses",
      args: [identity],
    },
  );
  if (voterAddresses) {
    result.submitAddress = voterAddresses.submitAddress.toLowerCase() as HexString;
    result.submitSignaturesAddress =
      voterAddresses.submitSignaturesAddress.toLowerCase() as HexString;
    result.signingPolicyAddress = voterAddresses.signingPolicyAddress.toLowerCase() as HexString;
    log(`✅ Submit Address: ${result.submitAddress}`);
    log(`✅ Submit Signatures Address: ${result.submitSignaturesAddress}`);
    log(`✅ Signing Policy Address: ${result.signingPolicyAddress}`);
  }

  const publicKeyParts = await readField<[HexString, HexString]>(
    client,
    strict,
    log,
    "getPublicKeyOf",
    "❌ Public Key: Missing",
    {
      address: entityManager,
      abi: entityManagerAbi,
      functionName: "getPublicKeyOf",
      args: [identity],
    },
  );
  if (publicKeyParts) {
    result.publicKey =
      `0x${publicKeyParts[0].slice(2)}${publicKeyParts[1].slice(2)}`.toLowerCase() as HexString;
    log(`✅ Public Key: ${result.publicKey}`);
  }

  const nodeIds = await readField<HexString[]>(
    client,
    strict,
    log,
    "getNodeIdsOf",
    "❌ Validators: Missing",
    {
      address: entityManager,
      abi: entityManagerAbi,
      functionName: "getNodeIdsOf",
      args: [identity],
    },
  );
  if (nodeIds) {
    const validators = nodeIds
      .map((nodeId) => encodeNodeID(nodeId))
      .filter((nodeId): nodeId is string => {
        if (!nodeId) return false;
        if (!isValidNodeID(nodeId)) {
          console.warn(`Warning: Generated NodeID ${nodeId} doesn't match expected format`);
        }
        return true;
      });

    result.validators = validators;
    if (validators.length > 0) {
      log("✅ Validators:");
      for (const nodeId of validators) {
        log(`    ${nodeId}`);
      }
    } else {
      log("❌ Validators: None registered");
    }
  }

  if (options.includeManagementGroup) {
    const readMembers = options.readManagementGroupMembers ?? fetchManagementGroupMembers;
    let members: readonly string[];
    try {
      members = await readMembers(network);
    } catch (error) {
      throw new Error(
        `Management Group member read failed for ${identity} on ${network.name}: ${errorText(error)}`,
        { cause: error },
      );
    }
    result.managementGroup = members.some((member) => member.toLowerCase() === identity);
  }

  return result;
}
