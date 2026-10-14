import type { ChainName } from "./config.js";

/**
 * Read-only access to the two authoritative reward-data repositories:
 *
 * - flare-foundation/fsp-rewards: final FSP reward claims + epoch info
 *   (weights, fees, addresses) per <chain>/<rewardEpochId>/.
 * - flare-foundation/reward-scripts: P-chain staking reward data per
 *   generated-files/reward-epoch-<id>/ (Flare only).
 *
 * Latest-epoch discovery lists the repo folder via the GitHub contents API
 * (a couple of calls per run, well within unauthenticated rate limits; set
 * GITHUB_TOKEN for headroom). File loads go through raw.githubusercontent.com.
 */

const API_BASE = "https://api.github.com/repos/flare-foundation";
const RAW_BASE = "https://raw.githubusercontent.com/flare-foundation";

// ── fsp-rewards types (subset of the published JSON) ──

export type ClaimType = 0 | 1 | 2 | 3 | 4; // DIRECT | FEE | WNAT | MIRROR | CCHAIN

export interface RewardClaim {
  body: {
    rewardEpochId: number;
    beneficiary: string;
    amount: string; // wei
    claimType: ClaimType;
  };
}

export interface RewardDistributionData {
  rewardEpochId: number;
  appliedMinConditions: boolean;
  rewardClaims: RewardClaim[];
}

export interface VoterRegistration {
  voterRegistrationInfo: {
    voter: string;
    delegationAddress: string;
    delegationFeeBIPS: number;
    wNatWeight: string; // wei
    wNatCappedWeight: string; // wei
    nodeIds: string[]; // 20-byte hex
    nodeWeights: string[]; // wei, parallel to nodeIds
  };
}

export interface RewardEpochInfo {
  rewardEpochId: number;
  voterRegistrationInfo: VoterRegistration[];
}

export interface FspEpochData {
  epochId: number;
  distribution: RewardDistributionData;
  epochInfo: RewardEpochInfo;
}

/**
 * One entry of <chain>/<epoch>/passes.json — the FIP.10/FIP.12 minimal-
 * conditions outcome per provider. `passes` is the count held after the epoch
 * (0–3); `eligibleForReward: false` means the provider had zero passes and
 * failed again, burning all FSP rewards for the epoch.
 */
export interface FspPassRecord {
  rewardEpochId: number;
  dataProviderName: string;
  voterAddress: string;
  passes: number;
  eligibleForReward: boolean;
  failures: { protocolId: number; failureId: string }[];
}

export interface FspPassesData {
  epochId: number;
  passes: FspPassRecord[];
}

// ── reward-scripts types (subset of nodes-data.json) ──

export interface NodeDelegator {
  pAddress: string;
  cAddress: string;
  amount: string; // gwei (P-chain uses 9 decimals)
  /** Absent when the node earned nothing (ineligible/burned). */
  delegatorRewardAmount?: string; // wei
}

export interface NodeData {
  nodeId: string; // "NodeID-..." (CB58)
  ftsoAddress: string;
  ftsoName: string;
  fee: number; // parts per million
  eligible: boolean;
  uptimeEligible: boolean;
  stakeEnd: number; // unix seconds
  rewardingWeight: string; // gwei
  totalStakeAmount: string; // gwei
  /** Absent when the node earned nothing (ineligible nodes carry burnedRewardAmount instead). */
  nodeRewardAmount?: string; // wei, total for the node
  validatorRewardAmount?: string; // wei, validator's own cut
  delegators: NodeDelegator[];
}

export interface StakingEpochData {
  epochId: number;
  nodes: NodeData[];
}

// ── Fetch helpers ──

async function fetchJson<T>(url: string): Promise<T | undefined> {
  const headers: Record<string, string> = { "User-Agent": "assets-repo" };
  if (url.startsWith(API_BASE) && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GET ${url} failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

async function listFolderNames(repo: string, folderPath: string): Promise<string[]> {
  const entries = await fetchJson<{ name: string; type: string }[]>(
    `${API_BASE}/${repo}/contents/${folderPath}`,
  );
  if (!entries) throw new Error(`repository folder ${repo}/${folderPath} not found`);
  return entries.filter((entry) => entry.type === "dir").map((entry) => entry.name);
}

/** How many epochs to walk back when the newest folder is still incomplete. */
const MAX_WALK_BACK = 3;

// ── fsp-rewards ──

export async function loadLatestFspEpoch(chain: ChainName): Promise<FspEpochData> {
  const names = await listFolderNames("fsp-rewards", chain);
  const latest = maxNumeric(names);
  for (let epochId = latest; epochId > latest - MAX_WALK_BACK; epochId--) {
    const data = await loadFspEpoch(chain, epochId);
    if (data) return data;
  }
  throw new Error(`no complete fsp-rewards data found for ${chain} near epoch ${latest}`);
}

/** Latest published passes.json (FSP minimal-conditions results) for a chain. */
export async function loadLatestFspPasses(chain: ChainName): Promise<FspPassesData> {
  const names = await listFolderNames("fsp-rewards", chain);
  const latest = maxNumeric(names);
  for (let epochId = latest; epochId > latest - MAX_WALK_BACK; epochId--) {
    const passes = await fetchJson<FspPassRecord[]>(
      `${RAW_BASE}/fsp-rewards/main/${chain}/${epochId}/passes.json`,
    );
    if (passes) return { epochId, passes };
  }
  throw new Error(`no fsp-rewards passes.json found for ${chain} near epoch ${latest}`);
}

async function loadFspEpoch(chain: ChainName, epochId: number): Promise<FspEpochData | undefined> {
  const base = `${RAW_BASE}/fsp-rewards/main/${chain}/${epochId}`;
  const [distribution, epochInfo] = await Promise.all([
    fetchJson<RewardDistributionData>(`${base}/reward-distribution-data.json`),
    fetchJson<RewardEpochInfo>(`${base}/reward-epoch-info.json`),
  ]);
  if (!distribution || !epochInfo) return undefined;
  return { epochId, distribution, epochInfo };
}

// ── reward-scripts (Flare staking) ──

export async function loadLatestStakingEpoch(): Promise<StakingEpochData> {
  const names = await listFolderNames("reward-scripts", "generated-files");
  const epochIds = names
    .map((name) => /^reward-epoch-(\d+)$/.exec(name)?.[1])
    .filter((id): id is string => id !== undefined);
  const latest = maxNumeric(epochIds);
  for (let epochId = latest; epochId > latest - MAX_WALK_BACK; epochId--) {
    const nodes = await fetchJson<NodeData[]>(
      `${RAW_BASE}/reward-scripts/main/generated-files/reward-epoch-${epochId}/nodes-data.json`,
    );
    if (nodes) return { epochId, nodes };
  }
  throw new Error(`no complete reward-scripts nodes-data found near epoch ${latest}`);
}

function maxNumeric(names: string[]): number {
  const ids = names.map(Number).filter((id) => Number.isInteger(id) && id >= 0);
  if (ids.length === 0) throw new Error("no numeric epoch folders found");
  return Math.max(...ids);
}
