import type { ChainName } from "./config.js";

/**
 * Read-only access to flare-foundation/fsp-rewards: epoch info and the
 * minimal-conditions results (passes.json) per <chain>/<rewardEpochId>/.
 *
 * Latest-epoch discovery lists the repo folder via the GitHub contents API
 * (a couple of calls per run, well within unauthenticated rate limits; set
 * GITHUB_TOKEN for headroom). File loads go through raw.githubusercontent.com.
 */

const API_BASE = "https://api.github.com/repos/flare-foundation";
const RAW_BASE = "https://raw.githubusercontent.com/flare-foundation";

// ── fsp-rewards types (subset of the published JSON) ──

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

/** Numeric fsp-rewards epoch folder ids for a chain, ascending. */
export async function listFspEpochIds(chain: ChainName): Promise<number[]> {
  const names = await listFolderNames("fsp-rewards", chain);
  return names
    .filter((name) => /^\d+$/.test(name))
    .map((name) => Number(name))
    .sort((a, b) => a - b);
}

/**
 * Raw reward-epoch-info.json for one published epoch.
 * Undefined when the file is not published yet (HTTP 404).
 */
export async function loadFspRewardEpochInfo(
  chain: ChainName,
  epochId: number,
): Promise<unknown | undefined> {
  return fetchJson(`${RAW_BASE}/fsp-rewards/main/${chain}/${epochId}/reward-epoch-info.json`);
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

function maxNumeric(names: string[]): number {
  const ids = names.map(Number).filter((id) => Number.isInteger(id) && id >= 0);
  if (ids.length === 0) throw new Error("no numeric epoch folders found");
  return Math.max(...ids);
}
