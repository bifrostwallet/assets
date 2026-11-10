import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderInfo } from "../config.js";
import { CHAINS, type ChainName } from "../earn/config.js";
import { listFspEpochIds, loadFspRewardEpochInfo } from "../earn/github.js";
import { formatFeeDelistReason, loadFeeObservations } from "../earn/listingFee.js";
import {
  ELIGIBILITY,
  evaluateEligibility,
  type ParsedEpochInfo,
  parseEpochInfo,
} from "../fspRewards.js";
import { isMain } from "../isMain.js";
import { isValidImage } from "../validate.js";

// Advisory provider audit against Flare's published reward data
// (github.com/flare-foundation/fsp-rewards). Reports:
// 1. Eligibility per curated provider (submitting / vote power / uptime)
// 2. Listed providers that fail eligibility (candidates for review)
// 3. Eligible providers not yet listed (candidates for listing)
// 4. Gap audit: identities earning rewards that are missing from data/providers
// 5. Listed providers over Bifrost's 50% delegation-fee cap (same rule as the
//    nightly delist). Advisory only — a breach does not fail CI.
//
// This never mutates data — curators act on the report. CI should treat the
// output as warnings, not failures. A failed fsp-rewards read is skipped
// (exit 0), same as the delegation-fee check.

const NETWORKS: { key: ChainName; chainPath: string }[] = [
  { key: "flare", chainPath: "eip155-14" },
  { key: "songbird", chainPath: "eip155-19" },
];

async function fetchEpochWindow(network: ChainName): Promise<ParsedEpochInfo[]> {
  const epochIds = await listFspEpochIds(network);
  const windowIds = epochIds.slice(-ELIGIBILITY.UPTIME_WINDOW_EPOCHS).reverse();

  const window: ParsedEpochInfo[] = [];
  for (const epochId of windowIds) {
    try {
      const info = await loadFspRewardEpochInfo(network, epochId);
      if (!info) {
        console.warn(`⚠️ Skipping ${network} epoch ${epochId}: reward-epoch-info.json not found`);
        continue;
      }
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

export async function checkNetwork(network: { key: ChainName; chainPath: string }): Promise<void> {
  console.info(`\n=== ${network.key.toUpperCase()} (${network.chainPath}) ===`);

  let window: ParsedEpochInfo[];
  try {
    window = await fetchEpochWindow(network.key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`\n⚠️ Epoch read skipped for ${network.key}: ${message}`);
    await reportListingFees(network.chainPath, loadCuratedProviders(network.chainPath));
    return;
  }

  if (window.length === 0) {
    console.warn(`⚠️ No epoch data available for ${network.key}`);
    await reportListingFees(network.chainPath, loadCuratedProviders(network.chainPath));
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

  await reportListingFees(network.chainPath, curated);
}

/**
 * Same fee rule as the nightly delist. Warns only — a breach or a failed
 * read must not fail `check:providers`.
 */
async function reportListingFees(chainPath: string, curated: ProviderInfo[]): Promise<void> {
  const chain = CHAINS.find((candidate) => candidate.chainPath === chainPath);
  if (!chain) return;
  const listed = curated.filter((provider) => provider.listed);
  if (listed.length === 0) return;

  try {
    const observations = await loadFeeObservations(chain, listed);
    const breaches: string[] = [];
    for (const provider of listed) {
      const observation = observations.get(provider.identityAddress.toLowerCase());
      if (!observation) continue;
      const reason = formatFeeDelistReason(observation);
      if (!reason) continue;
      breaches.push(`${provider.name} (${provider.identityAddress}): ${reason}`);
    }
    if (breaches.length === 0) {
      console.info("\n✅ No listed provider is above Bifrost's 50% delegation-fee cap");
      return;
    }
    console.warn(
      `\n⚠️ Listed above Bifrost's 50% delegation-fee cap (${breaches.length}; advisory, does not fail CI):`,
    );
    for (const line of breaches) {
      console.warn(`   ${line}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`\n⚠️ Delegation-fee check skipped for ${chainPath}: ${message}`);
  }
}

const LOGO_HASH_RE = /^[0-9a-f]{64}$/;

/** Same logo rules as tokens, contracts, and dapps: path, hash, WebP, 128×128, 24 KB. */
function providerLogoErrors(): string[] {
  const errors: string[] = [];
  const root = path.join(process.cwd(), "data", "providers");
  if (!fs.existsSync(root)) return ["data/providers is missing"];
  for (const chain of fs.readdirSync(root, { withFileTypes: true })) {
    if (!chain.isDirectory()) continue;
    const chainDir = path.join(root, chain.name);
    for (const provider of fs.readdirSync(chainDir, { withFileTypes: true })) {
      if (!provider.isDirectory()) continue;
      const label = `providers/${chain.name}/${provider.name}`;
      const infoPath = path.join(chainDir, provider.name, "info.json");
      const logoPath = path.join(chainDir, provider.name, "logo.webp");
      if (!fs.existsSync(infoPath)) {
        errors.push(`${label}: missing info.json`);
        continue;
      }
      const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
      const expected = `providers/${chain.name}/${info.identityAddress}/logo.webp`;
      if (info.logoURL !== expected) errors.push(`${label}: logoURL must be ${expected}`);
      if (typeof info.logoHash !== "string" || !LOGO_HASH_RE.test(info.logoHash)) {
        errors.push(`${label}: logoHash must be a lowercase SHA-256 hex digest`);
      }
      if (!fs.existsSync(logoPath)) {
        errors.push(`${label}: logo.webp is missing`);
        continue;
      }
      const check = isValidImage(logoPath);
      if (!check.isValid) {
        for (const error of check.errors) errors.push(`${label}: ${error}`);
      }
      if (typeof info.logoHash === "string") {
        const actual = createHash("sha256").update(fs.readFileSync(logoPath)).digest("hex");
        if (actual !== info.logoHash) errors.push(`${label}: logoHash does not match logo.webp`);
      }
    }
  }
  return errors;
}

async function main(): Promise<void> {
  const logoErrors = providerLogoErrors();
  if (logoErrors.length > 0) {
    console.error(`❌ Provider logos invalid (${logoErrors.length}):`);
    for (const error of logoErrors) console.error(`  ${error}`);
    process.exitCode = 1;
  }
  for (const network of NETWORKS) {
    await checkNetwork(network);
  }
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error("❌ Provider check failed:", error);
    process.exitCode = 1;
  });
}
