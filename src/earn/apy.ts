import { decodeNodeID } from "../convert.js";
import { EPOCHS_PER_YEAR_DEN, EPOCHS_PER_YEAR_NUM } from "./config.js";
import type { FspEpochData, StakingEpochData } from "./github.js";

/**
 * APY math. All rates are computed from the single most recent epoch and
 * extrapolated to a year (x ~104.36), expressed in basis points of the native
 * token (FLR/SGB). A provider or node that earned nothing in the latest epoch
 * gets 0 bps -- deliberately, per the Earn view spec.
 *
 * Everything is BigInt on the wei/gwei strings from the source files; the
 * only division happens at the end, into integer basis points.
 */

export interface ProviderApy {
  identityAddress: string;
  delegationAddress: string;
  name: string | null;
  /** Annualized delegation yield, basis points. Fees already deducted. */
  apyBps: number;
  /** The provider's delegation fee, basis points (informational). */
  feeBps: number;
  /** Rewards accrue on capped weight but dilute over full weight. */
  overDelegationCap: boolean;
  wnatAmountWei: string;
  wNatWeightWei: string;
}

export interface ValidatorApy {
  nodeId: string; // "NodeID-..." form
  nodeIdHex: string; // 20-byte hex form
  /** FSP identity address of the data provider owning this node, if registered. */
  identityAddress: string | null;
  name: string | null;
  /** Combined annualized staking yield (mirror + validator rewards), bps. */
  apyBps: number;
  mirrorApyBps: number;
  stakingApyBps: number;
  /** The validator's staking fee, parts per million (informational). */
  feePpm: number;
  eligible: boolean;
  stakeEnd: number;
  mirrorAmountWei: string;
  nodeWeightWei: string;
  delegatorRewardsWei: string;
  delegatedAmountGwei: string;
}

const WNAT = 2;
const MIRROR = 3;
const GWEI = 10n ** 9n;

/** amount/weight per epoch, annualized, in basis points (truncated). */
function annualizedBps(amountWei: bigint, weightWei: bigint): number {
  if (weightWei === 0n || amountWei <= 0n) return 0;
  return Number((amountWei * 10_000n * EPOCHS_PER_YEAR_NUM) / (weightWei * EPOCHS_PER_YEAR_DEN));
}

function claimsByBeneficiary(fsp: FspEpochData, claimType: number): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const claim of fsp.distribution.rewardClaims) {
    if (claim.body.claimType !== claimType) continue;
    const key = claim.body.beneficiary.toLowerCase();
    map.set(key, (map.get(key) ?? 0n) + BigInt(claim.body.amount));
  }
  return map;
}

interface NodeRegistration {
  voter: string; // FSP identity address, lowercase
  weight: bigint; // wei
}

function nodeIdToHex(nodeId: string): string {
  const hex = decodeNodeID(nodeId);
  if (!hex) {
    throw new Error(`invalid node id "${nodeId}"`);
  }
  return hex.toLowerCase();
}

/**
 * nodeIdHex -> owning FSP voter and stake weight. This is the only reliable
 * join between the two datasets: the ftsoAddress in nodes-data.json is the
 * legacy FTSOv1 provider address, not the FSP identity address.
 */
function nodeRegistrations(fsp: FspEpochData): Map<string, NodeRegistration> {
  const map = new Map<string, NodeRegistration>();
  for (const voter of fsp.epochInfo.voterRegistrationInfo) {
    const info = voter.voterRegistrationInfo;
    info.nodeIds.forEach((nodeId, index) => {
      map.set(nodeId.toLowerCase(), {
        voter: info.voter.toLowerCase(),
        weight: BigInt(info.nodeWeights[index] ?? "0"),
      });
    });
  }
  return map;
}

/**
 * One entry per registered voter: annualized delegation yield from the WNAT
 * community claim over the provider's delegation weight.
 */
export function computeProviderApys(
  fsp: FspEpochData,
  namesByIdentity: Map<string, string> = new Map(),
): ProviderApy[] {
  const wnatClaims = claimsByBeneficiary(fsp, WNAT);

  return fsp.epochInfo.voterRegistrationInfo.map((voter) => {
    const info = voter.voterRegistrationInfo;
    const identity = info.voter.toLowerCase();
    const delegationAddress = info.delegationAddress.toLowerCase();
    const amount = wnatClaims.get(delegationAddress) ?? 0n;
    const weight = BigInt(info.wNatWeight);

    return {
      identityAddress: identity,
      delegationAddress,
      name: namesByIdentity.get(identity) ?? null,
      apyBps: annualizedBps(amount, weight),
      feeBps: info.delegationFeeBIPS,
      overDelegationCap: BigInt(info.wNatCappedWeight) < weight,
      wnatAmountWei: amount.toString(),
      wNatWeightWei: info.wNatWeight,
    };
  });
}

/**
 * One entry per validator node in the staking data (the authoritative node
 * list). Two independent yield streams are summed:
 *
 * - Mirror: the node's FSP MIRROR claim over its stake weight (both wei,
 *   from fsp-rewards).
 * - Validator rewards: what delegators actually earned over what they had
 *   staked (rewards in wei, stakes in P-chain gwei, from reward-scripts).
 *   The per-delegator figures already reflect the validator fee, boost and
 *   weight capping. A node with no delegators yet falls back to the
 *   fee-adjusted node reward over its rewarding weight.
 */
export function computeValidatorApys(fsp: FspEpochData, staking: StakingEpochData): ValidatorApy[] {
  const mirrorClaims = claimsByBeneficiary(fsp, MIRROR);
  const registrations = nodeRegistrations(fsp);

  return staking.nodes.map((node) => {
    const nodeIdHex = nodeIdToHex(node.nodeId);
    const eligible = node.eligible && node.uptimeEligible;
    const registration = registrations.get(nodeIdHex);

    const mirrorAmount = mirrorClaims.get(nodeIdHex) ?? 0n;
    const nodeWeight = registration?.weight ?? 0n;
    const mirrorApyBps = annualizedBps(mirrorAmount, nodeWeight);

    // Reward fields are absent entirely when the node earned nothing
    // (ineligible/burned); treat them as zero so the APY comes out as 0%.
    let delegatorRewards = 0n;
    let delegatedAmount = 0n;
    for (const delegator of node.delegators) {
      delegatorRewards += BigInt(delegator.delegatorRewardAmount ?? "0");
      delegatedAmount += BigInt(delegator.amount);
    }

    let stakingApyBps: number;
    if (delegatedAmount > 0n) {
      stakingApyBps = annualizedBps(delegatorRewards, delegatedAmount * GWEI);
    } else {
      // No delegators yet: what a first delegator would have earned, i.e. the
      // node's reward after the validator fee, over its rewarding weight.
      const nodeReward = BigInt(node.nodeRewardAmount ?? "0");
      const netReward = (nodeReward * BigInt(1_000_000 - node.fee)) / 1_000_000n;
      stakingApyBps = annualizedBps(netReward, BigInt(node.rewardingWeight) * GWEI);
    }

    return {
      nodeId: node.nodeId,
      nodeIdHex,
      identityAddress: registration?.voter ?? null,
      name: node.ftsoName || null,
      apyBps: mirrorApyBps + stakingApyBps,
      mirrorApyBps,
      stakingApyBps,
      feePpm: node.fee,
      eligible,
      stakeEnd: node.stakeEnd,
      mirrorAmountWei: mirrorAmount.toString(),
      nodeWeightWei: nodeWeight.toString(),
      delegatorRewardsWei: delegatorRewards.toString(),
      delegatedAmountGwei: delegatedAmount.toString(),
    };
  });
}

/**
 * FSP identity address -> ftsoName, for enriching Flare provider entries.
 * Joined through node ownership (nodes-data nodeId -> fsp voter), since
 * nodes-data's ftsoAddress is the legacy FTSOv1 address, not the FSP
 * identity. Prefer curated catalog names when present.
 */
export function providerNames(staking: StakingEpochData, fsp: FspEpochData): Map<string, string> {
  const registrations = nodeRegistrations(fsp);
  const names = new Map<string, string>();
  for (const node of staking.nodes) {
    if (!node.ftsoName) continue;
    const registration = registrations.get(nodeIdToHex(node.nodeId));
    if (registration) names.set(registration.voter, node.ftsoName);
  }
  return names;
}
