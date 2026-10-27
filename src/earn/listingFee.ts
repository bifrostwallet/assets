import { BLOCKCHAIN_NETWORKS, FLARE_CONTRACT_REGISTRY, type ProviderInfo } from "../config.js";
import { createNetworkClient } from "../onchain.js";
import type { HexString } from "../validate.js";
import type { ChainConfig } from "./config.js";

/**
 * Bifrost's own listing recommendation — not a Flare or Songbird protocol rule.
 *
 * A listed operator is over the cap when its current FTSO/FSP delegation fee
 * is strictly above 50%, or when any of its currently validating Flare P-chain
 * nodes charges a delegation fee strictly above 50%. Exactly 50% stays listed.
 * 20% (2000 bips) is the usual fee. Fees below that are allowed; there is no
 * lower bound. One validator over the cap delists the whole operator.
 *
 * `delegationFeeBIPS` in fsp-rewards reward-epoch-info.json (parsed as
 * `feeBips` in fspRewards.ts) is the fee locked for that reward epoch. The
 * latest published epoch lags the current reward epoch, so it is not the fee
 * charged now. Listing reads `WNatDelegationFee.getVoterCurrentFeePercentage`
 * (uint16 BIPS), resolved by name through FlareContractRegistry.
 *
 * Validator fees come from `platform.getCurrentValidators` (`delegationFee`,
 * a percent string such as "20.0000"). reward-scripts nodes-data.json `fee`
 * (ppm) covers a past epoch and includes nodes that are no longer validating,
 * so it is not used here. Songbird has no P-chain staking.
 *
 * Current WNatDelegationFee deployments (registry is authoritative):
 * Flare 0x5A1fDF4e39201Ef847DDcDca1065a9A2BB007600,
 * Songbird 0xd38Bc34139159a95ab5DcC0D259C7e428E2F9F16.
 */

/** 50% in BIPS. Strictly above this is over Bifrost's listing cap. */
export const LISTING_FEE_CAP_BIPS = 5_000;

/** 100% in BIPS. One bip is 0.01%, so 50.01% is 5001 bips. */
const BIPS_PER_FULL_FEE = 10_000;

const FLARE_P_CHAIN_API = "https://flare-api.flare.network/ext/bc/P";
const FEE_READ_CONCURRENCY = 8;

const registryAbi = [
  {
    type: "function",
    name: "getContractAddressByName",
    stateMutability: "view",
    inputs: [{ type: "string" }],
    outputs: [{ type: "address" }],
  },
] as const;

const wNatDelegationFeeAbi = [
  {
    type: "function",
    name: "getVoterCurrentFeePercentage",
    stateMutability: "view",
    inputs: [{ name: "_voter", type: "address" }],
    outputs: [{ name: "", type: "uint16" }],
  },
] as const;

export interface ValidatorFeeObservation {
  nodeId: string;
  /** Percent string from platform.getCurrentValidators, for example "100.0000". */
  delegationFee: string;
}

export interface ListingFeeObservation {
  /** Current FTSO/FSP fee in BIPS, or null when that identity's read failed. */
  ftsoFeeBips: number | null;
  /** Subset of the operator's NodeIDs that are currently validating. */
  validatingNodes: ValidatorFeeObservation[];
}

interface ScaledPercent {
  value: bigint;
  scale: bigint;
}

/** True when a BIPS fee is strictly above 50%. 5000 stays; 5001 (50.01%) does not. */
export function bipsExceedListingCap(feeBips: number): boolean {
  return Number.isFinite(feeBips) && feeBips > LISTING_FEE_CAP_BIPS;
}

/**
 * Parses a P-chain delegation-fee percent ("50.0000", "50.0100").
 * Returns null when the string is not a non-negative decimal.
 */
export function parseDelegationFeePercent(delegationFee: string): ScaledPercent | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(delegationFee.trim());
  if (!match?.[1]) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > 18) return null;
  const scale = 10n ** BigInt(fraction.length);
  const value = BigInt(match[1]) * scale + (fraction === "" ? 0n : BigInt(fraction));
  return { value, scale };
}

/** True when a percent string is strictly above 50%. "50.0000" stays; "50.0100" does not. */
export function delegationFeePercentExceedsListingCap(delegationFee: string): boolean {
  const parsed = parseDelegationFeePercent(delegationFee);
  if (!parsed) return false;
  return parsed.value > 50n * parsed.scale;
}

function formatFeeBips(feeBips: number): string {
  const bips = Math.trunc(feeBips);
  const sign = bips < 0 ? "-" : "";
  const absolute = Math.abs(bips);
  const whole = Math.floor(absolute / 100);
  const fraction = absolute % 100;
  if (fraction === 0) return `${sign}${whole}%`;
  return `${sign}${whole}.${String(fraction).padStart(2, "0")}%`;
}

/**
 * Reason to set `listed: false`, or null when the operator is within the cap.
 * A validator breach delists the whole operator. Nodes omitted from
 * `validatingNodes` (not currently validating) do not count.
 */
export function formatFeeDelistReason(observation: ListingFeeObservation): string | null {
  const parts: string[] = [];
  if (observation.ftsoFeeBips != null && bipsExceedListingCap(observation.ftsoFeeBips)) {
    parts.push(
      `FTSO/FSP delegation fee ${formatFeeBips(observation.ftsoFeeBips)} (${observation.ftsoFeeBips} bips)`,
    );
  }
  for (const node of observation.validatingNodes) {
    if (!delegationFeePercentExceedsListingCap(node.delegationFee)) continue;
    parts.push(`validator ${node.nodeId} delegation fee ${node.delegationFee}%`);
  }
  if (parts.length === 0) return null;
  return `Bifrost listing recommendation (not a protocol rule): delegation fee above 50% (${parts.join("; ")})`;
}

interface CurrentValidator {
  nodeID?: string;
  delegationFee?: string;
}

/** nodeID -> delegationFee for validators in the current Flare P-chain set. */
export async function fetchCurrentValidatorFees(): Promise<Map<string, string>> {
  const response = await fetch(FLARE_P_CHAIN_API, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "assets-repo" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "platform.getCurrentValidators",
      params: {},
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`platform.getCurrentValidators failed with status ${response.status}`);
  }
  const body = (await response.json()) as {
    error?: { message?: string };
    result?: { validators?: CurrentValidator[] };
  };
  if (body.error) {
    throw new Error(body.error.message ?? "platform.getCurrentValidators returned an error");
  }
  const validators = body.result?.validators;
  if (!validators || validators.length === 0) {
    throw new Error("platform.getCurrentValidators returned no validators");
  }

  const fees = new Map<string, string>();
  for (const validator of validators) {
    if (typeof validator.nodeID !== "string" || typeof validator.delegationFee !== "string") {
      continue;
    }
    fees.set(validator.nodeID, validator.delegationFee);
  }
  if (fees.size === 0) {
    throw new Error("platform.getCurrentValidators returned no delegation fees");
  }
  return fees;
}

async function mapPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      const item = items[current];
      if (item === undefined) continue;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function fetchFtsoFeeBips(
  chain: ChainConfig,
  identities: readonly string[],
): Promise<Map<string, number | null>> {
  const network = Object.values(BLOCKCHAIN_NETWORKS).find((item) => item.path === chain.chainPath);
  if (!network) {
    throw new Error(`No RPC config for ${chain.chainPath}`);
  }

  const client = createNetworkClient(network);
  const feeAddress = (await client.readContract({
    address: FLARE_CONTRACT_REGISTRY as HexString,
    abi: registryAbi,
    functionName: "getContractAddressByName",
    args: ["WNatDelegationFee"],
  })) as HexString;

  if (feeAddress.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    throw new Error(`WNatDelegationFee is not registered on ${chain.name}`);
  }

  const fees = new Map<string, number | null>();
  await mapPool(identities, FEE_READ_CONCURRENCY, async (identity) => {
    const key = identity.toLowerCase();
    try {
      const feeBips = Number(
        await client.readContract({
          address: feeAddress,
          abi: wNatDelegationFeeAbi,
          functionName: "getVoterCurrentFeePercentage",
          args: [key as HexString],
        }),
      );
      if (!Number.isInteger(feeBips) || feeBips < 0 || feeBips > BIPS_PER_FULL_FEE) {
        throw new Error(`unexpected fee ${feeBips}`);
      }
      fees.set(key, feeBips);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`⚠️ ${chain.name} FTSO fee read failed for ${key}: ${message}`);
      fees.set(key, null);
    }
  });

  if (identities.length > 0 && [...fees.values()].every((fee) => fee == null)) {
    throw new Error(
      `WNatDelegationFee.getVoterCurrentFeePercentage failed for every ${chain.name} provider`,
    );
  }
  return fees;
}

/**
 * Current FTSO fees, plus Flare validator fees for NodeIDs that are validating
 * right now. Missing FTSO reads are null (not a breach). Songbird skips the
 * P-chain.
 */
export async function loadFeeObservations(
  chain: ChainConfig,
  providers: readonly Pick<ProviderInfo, "identityAddress" | "validators">[],
): Promise<Map<string, ListingFeeObservation>> {
  const identities = providers.map((provider) => provider.identityAddress);
  const [ftsoFees, validatorFees] = await Promise.all([
    fetchFtsoFeeBips(chain, identities),
    chain.hasValidators ? fetchCurrentValidatorFees() : Promise.resolve(new Map<string, string>()),
  ]);

  console.info(
    chain.hasValidators
      ? `ℹ️  ${chain.name}: delegation fees read (${providers.length} FTSO identities, ${validatorFees.size} current validators)`
      : `ℹ️  ${chain.name}: delegation fees read (${providers.length} FTSO identities; no P-chain staking)`,
  );

  const observations = new Map<string, ListingFeeObservation>();
  for (const provider of providers) {
    const identity = provider.identityAddress.toLowerCase();
    const validatingNodes: ValidatorFeeObservation[] = [];
    const seen = new Set<string>();
    if (chain.hasValidators) {
      for (const nodeId of provider.validators ?? []) {
        if (seen.has(nodeId)) continue;
        seen.add(nodeId);
        const delegationFee = validatorFees.get(nodeId);
        if (delegationFee == null) continue;
        if (parseDelegationFeePercent(delegationFee) == null) {
          console.warn(`⚠️ Unparseable delegation fee for ${nodeId}: ${delegationFee}`);
          continue;
        }
        validatingNodes.push({ nodeId, delegationFee });
      }
    }
    observations.set(identity, {
      ftsoFeeBips: ftsoFees.get(identity) ?? null,
      validatingNodes,
    });
  }
  return observations;
}
