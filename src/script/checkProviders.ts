import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderInfo } from "../config.js";
import {
  ELIGIBILITY,
  evaluateEligibility,
  type ParsedEpochInfo,
  parseEpochInfo,
} from "../fspRewards.js";

// Advisory provider audit against Flare's published reward data
// (github.com/flare-foundation/fsp-rewards). Reports:
// 1. Eligibility per curated provider (submitting / vote power / uptime)
// 2. Listed providers that fail eligibility (candidates for review)
// 3. Eligible providers not yet listed (candidates for listing)
// 4. Gap audit: identities earning rewards that are missing from data/providers
//
// This never mutates data — curators act on the report. CI should treat the
// output as warnings, not failures.

const FSP_REWARDS_API = "https://api.github.com/repos/flare-foundation/fsp-rewards/contents";
const FSP_REWARDS_RAW = "https://raw.githubusercontent.com/flare-foundation/fsp-rewards/main";

const NETWORKS: { key: "flare" | "songbird"; chainPath: string }[] = [
  { key: "flare", chainPath: "eip155-14" },
  { key: "songbird", chainPath: "eip155-19" },
];

async function fetchJSON<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { "User-Agent": "assets-repo" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return (await response.json()) as T;
}

/** Lists available epoch ids for a network folder, ascending */
async function listEpochIds(network: string): Promise<number[]> {
  const entries = await fetchJSON<{ name: string; type: string }[]>(
    `${FSP_REWARDS_API}/${network}`,
  );
  return entries
    .filter((entry) => entry.type === "dir" && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((a, b) => a - b);
}

async function fetchEpochWindow(network: string): Promise<ParsedEpochInfo[]> {
  const epochIds = await listEpochIds(network);
  const windowIds = epochIds.slice(-ELIGIBILITY.UPTIME_WINDOW_EPOCHS).reverse();

  const window: ParsedEpochInfo[] = [];
  for (const epochId of windowIds) {
    try {
      const info = await fetchJSON(
        `${FSP_REWARDS_RAW}/${network}/${epochId}/reward-epoch-info.json`,
      );
      window.push(parseEpochInfo(info));
    } catch (error) {
      console.warn(`⚠️ Skipping ${network} epoch ${epochId}: ${error}`);
    }
  }
  return window;
}

function loadCuratedProviders(chainPath: string): ProviderInfo[] {
  const allPath = path.join(process.cwd(), "data", "providers", chainPath, "all.json");
  if (!fs.existsSync(allPath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(allPath, "utf8")) as ProviderInfo[];
}

function checkMark(value: boolean | null): string {
  if (value === null) return "❓";
  return value ? "✅" : "❌";
}

async function checkNetwork(network: { key: string; chainPath: string }): Promise<void> {
  console.info(`\n=== ${network.key.toUpperCase()} (${network.chainPath}) ===`);

  const window = await fetchEpochWindow(network.key);
  if (window.length === 0) {
    console.warn(`⚠️ No epoch data available for ${network.key}`);
    return;
  }
  console.info(
    `Window: ${window.length} epoch(s), latest ${window[0].epochId} (uptime needs ${ELIGIBILITY.UPTIME_WINDOW_EPOCHS})`,
  );

  const curated = loadCuratedProviders(network.chainPath);
  const curatedByIdentity = new Map(curated.map((p) => [p.identityAddress.toLowerCase(), p]));

  // 1) Eligibility per curated provider
  const failingListed: string[] = [];
  const eligibleUnlisted: string[] = [];

  console.info("\nProvider eligibility (submitting / vote power / uptime):");
  for (const provider of curated) {
    const identity = provider.identityAddress.toLowerCase();
    const checks = evaluateEligibility(identity, window);
    const flags = `${checkMark(checks.submitting)}${checkMark(checks.votePower)}${checkMark(checks.uptime)}`;
    const status = checks.eligible ? "eligible" : "not eligible";
    console.info(
      `  ${flags} ${provider.name} (${identity}) — ${status}, present ${checks.presentEpochs}/${checks.windowEpochs}${provider.listed ? " [listed]" : ""}`,
    );

    if (provider.listed && !checks.eligible) {
      failingListed.push(`${provider.name} (${identity})`);
    }
    if (!provider.listed && checks.eligible) {
      eligibleUnlisted.push(`${provider.name} (${identity})`);
    }
  }

  // 2) Gap audit: on-chain identities missing from curated data
  const latestIdentities = window[0].entities.map((entity) => entity.identity);
  const missing = latestIdentities.filter((identity) => !curatedByIdentity.has(identity));

  if (failingListed.length > 0) {
    console.warn(`\n⚠️ Listed but failing eligibility (${failingListed.length}):`);
    for (const provider of failingListed) {
      console.warn(`   ${provider}`);
    }
  }

  if (eligibleUnlisted.length > 0) {
    console.info(`\n💡 Eligible but not listed (${eligibleUnlisted.length}):`);
    for (const provider of eligibleUnlisted) {
      console.info(`   ${provider}`);
    }
  }

  if (missing.length > 0) {
    console.warn(
      `\n⚠️ Registered on-chain in epoch ${window[0].epochId} but missing from data/providers/${network.chainPath} (${missing.length}):`,
    );
    for (const identity of missing) {
      console.warn(`   ${identity}`);
    }
  } else {
    console.info("\n✅ No gap: every on-chain registered entity is curated");
  }
}

async function main(): Promise<void> {
  for (const network of NETWORKS) {
    await checkNetwork(network);
  }
}

main().catch((error) => {
  console.error("❌ Provider check failed:", error);
  process.exitCode = 1;
});
