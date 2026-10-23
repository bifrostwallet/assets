import { createPublicClient, http, type PublicClient } from "viem";
import type { BlockchainNetworkConfig, ProviderInfo } from "./config.js";
import { encodeNodeID } from "./convert.js";
import { type HexString, isValidNodeID } from "./validate.js";

interface VoterAddresses {
  submitAddress: HexString;
  submitSignaturesAddress: HexString;
  signingPolicyAddress: HexString;
}

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

export function createNetworkClient(network: BlockchainNetworkConfig): PublicClient {
  return createPublicClient({
    chain: {
      id: network.chain,
      name: network.name,
      network: network.name.toLowerCase(),
      nativeCurrency: { name: network.name, symbol: network.symbol, decimals: 18 },
      rpcUrls: { default: { http: [network.rpc] } },
    },
    transport: http(network.rpc, { timeout: 30000, retryCount: 3, retryDelay: 1000 }),
  });
}

/**
 * Fetches a provider's on-chain entity data from the EntityManager:
 * delegation, submit, submit-signatures and signing-policy addresses,
 * public key, and validator NodeIDs.
 */
export async function fetchEntityData(
  identityAddress: string,
  network: BlockchainNetworkConfig,
  options: { log?: boolean } = {},
): Promise<Partial<ProviderInfo>> {
  const log = options.log ? console.info : () => {};
  const client = createNetworkClient(network);
  const entityManager = network.entityManager as HexString;
  const identity = identityAddress.toLowerCase() as HexString;

  const result: Partial<ProviderInfo> = { identityAddress: identity };
  log(`✅ Identity Address: ${identity}`);

  try {
    const delegationAddress = (await client.readContract({
      address: entityManager,
      abi: entityManagerAbi,
      functionName: "getDelegationAddressOf",
      args: [identity],
    })) as HexString;
    result.delegationAddress = delegationAddress.toLowerCase() as HexString;
    log(`✅ Delegation Address: ${result.delegationAddress}`);
  } catch {
    log("❌ Delegation Address: Missing");
  }

  try {
    const voterAddresses = (await client.readContract({
      address: entityManager,
      abi: entityManagerAbi,
      functionName: "getVoterAddresses",
      args: [identity],
    })) as VoterAddresses;

    result.submitAddress = voterAddresses.submitAddress.toLowerCase() as HexString;
    result.submitSignaturesAddress =
      voterAddresses.submitSignaturesAddress.toLowerCase() as HexString;
    result.signingPolicyAddress = voterAddresses.signingPolicyAddress.toLowerCase() as HexString;
    log(`✅ Submit Address: ${result.submitAddress}`);
    log(`✅ Submit Signatures Address: ${result.submitSignaturesAddress}`);
    log(`✅ Signing Policy Address: ${result.signingPolicyAddress}`);
  } catch {
    log("❌ Voter Addresses: Missing");
  }

  try {
    const publicKeyParts = (await client.readContract({
      address: entityManager,
      abi: entityManagerAbi,
      functionName: "getPublicKeyOf",
      args: [identity],
    })) as [HexString, HexString];

    result.publicKey =
      `0x${publicKeyParts[0].slice(2)}${publicKeyParts[1].slice(2)}`.toLowerCase() as HexString;
    log(`✅ Public Key: ${result.publicKey}`);
  } catch {
    log("❌ Public Key: Missing");
  }

  try {
    const nodeIds = (await client.readContract({
      address: entityManager,
      abi: entityManagerAbi,
      functionName: "getNodeIdsOf",
      args: [identity],
    })) as HexString[];

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
  } catch {
    log("❌ Validators: Missing");
  }

  return result;
}
