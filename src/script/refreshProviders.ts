import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderInfo } from "../config.js";
import { computeProviderApys, computeValidatorApys, providerNames } from "../earn/apy.js";
import { CHAINS, type ChainConfig, type EarnConfig } from "../earn/config.js";
import {
  applyDelistCandidates,
  findDelistCandidates,
  formatDelistSummary,
} from "../earn/delist.js";
import {
  loadLatestFspEpoch,
  loadLatestStakingEpoch,
  type StakingEpochData,
} from "../earn/github.js";
import { buildEarnData, createStore, type EarnStore } from "../earn/output.js";
import { isMain } from "../isMain.js";
import { syncDomainLinkage } from "./syncDomainLinkage.js";

/**
 * Nightly provider refresh:
 * 1. Compute Earn APY from fsp-rewards (+ reward-scripts on Flare) and write
 *    private earn JSON to GCS (or ./out with --dry-run). No human gate.
 *    Skip with --skip-earn.
 * 2. With --write-domain: persist domainLinked into git (unsigned flag; CI
 *    commits straight to main). Skip the check entirely with --skip-domain.
 * 3. With --write-delist: flip listed:false for providers that burned FSP
 *    rewards (eligibleForReward=false in the latest passes.json). CI applies
 *    this on a branch and opens a PR — never straight to main.
 *
 * Usage:
 *   ./yarn refresh:providers
 *   ./yarn refresh:providers --dry-run
 *   ./yarn refresh:providers --write-domain
 *   ./yarn refresh:providers --write-delist --skip-earn --skip-domain
 *   EARN_BUCKET=<private-earn-bucket> ./yarn refresh:providers
 */

interface RefreshArgs {
  dryRun: boolean;
  writeDomain: boolean;
  writeDelist: boolean;
  skipEarn: boolean;
  skipDomain: boolean;
}

function parseArgs(argv: string[]): RefreshArgs {
  return {
    dryRun: argv.includes("--dry-run"),
    writeDomain: argv.includes("--write-domain"),
    writeDelist: argv.includes("--write-delist"),
    skipEarn: argv.includes("--skip-earn"),
    skipDomain: argv.includes("--skip-domain"),
  };
}

function loadCatalogNames(chainPath: string): Map<string, string> {
  const allPath = path.join(process.cwd(), "data", "providers", chainPath, "all.json");
  const names = new Map<string, string>();
  if (!fs.existsSync(allPath)) return names;

  const providers = JSON.parse(fs.readFileSync(allPath, "utf8")) as ProviderInfo[];
  for (const provider of providers) {
    if (provider.name) {
      names.set(provider.identityAddress.toLowerCase(), provider.name);
    }
  }
  return names;
}

function resolveEarnConfig(dryRun: boolean): EarnConfig {
  if (dryRun) {
    return { bucket: "", dryRun: true };
  }
  const bucket = process.env.EARN_BUCKET ?? "";
  if (!bucket) {
    throw new Error(
      "EARN_BUCKET is required (private earn GCS bucket). Pass --dry-run for local out/ writes.",
    );
  }
  return { bucket, dryRun: false };
}

async function processChain(chain: ChainConfig, store: EarnStore): Promise<void> {
  const [current, fsp, staking] = await Promise.all([
    store.readLatest(chain.name),
    loadLatestFspEpoch(chain.name),
    chain.hasValidators ? loadLatestStakingEpoch() : Promise.resolve(undefined),
  ]);

  const stakingEpochId = staking?.epochId ?? null;
  if (current && current.fspEpochId === fsp.epochId && current.stakingEpochId === stakingEpochId) {
    console.info(
      `ℹ️  ${chain.name}: no new epoch data (fsp=${fsp.epochId}, staking=${stakingEpochId}), skipping earn write`,
    );
    return;
  }

  const catalogNames = loadCatalogNames(chain.chainPath);
  const stakingNames = staking ? providerNames(staking, fsp) : new Map<string, string>();
  const names = new Map([...stakingNames, ...catalogNames]);

  const providers = computeProviderApys(fsp, names);
  const validators = staking ? computeValidatorApys(fsp, staking as StakingEpochData) : [];

  const data = buildEarnData(chain.name, fsp.epochId, stakingEpochId, providers, validators);
  const written = await store.write(data);

  console.info(
    `✅ ${chain.name}: earn data written (fsp=${fsp.epochId}, staking=${stakingEpochId}, providers=${providers.length}, validators=${validators.length})`,
  );
  for (const writtenPath of written) {
    console.info(`   ${writtenPath}`);
  }
}

async function publishEarn(config: EarnConfig): Promise<void> {
  const store = createStore(config);
  if (config.dryRun) {
    console.warn("⚠️  DRY_RUN: writing earn APY to ./out instead of GCS");
  }

  let failed = false;
  for (const chain of CHAINS) {
    try {
      await processChain(chain, store);
    } catch (err) {
      failed = true;
      console.error(`❌ ${chain.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed) {
    throw new Error("One or more earn APY chains failed");
  }
}

async function refreshProviders(): Promise<void> {
  const { dryRun, writeDomain, writeDelist, skipEarn, skipDomain } = parseArgs(
    process.argv.slice(2),
  );

  if (skipEarn) {
    console.info("ℹ️  --skip-earn: not publishing earn APY");
  } else {
    const earnConfig = resolveEarnConfig(dryRun);
    await publishEarn(earnConfig);
  }

  const summaryParts: string[] = [];

  if (skipDomain) {
    console.info("ℹ️  --skip-domain: not checking domain linkage");
  } else {
    console.info("\n🔗 Domain linkage");
    const domainResult = await syncDomainLinkage({ dryRun: dryRun || !writeDomain });
    if (!writeDomain && !dryRun) {
      console.info(
        "ℹ️  Domain linkage was checked only — re-run with --write-domain to persist domainLinked (CI)",
      );
    }
    summaryParts.push(
      "## Domain linkage",
      "",
      `- Checked: ${domainResult.checked}`,
      `- Linked: ${domainResult.linked}`,
      `- ${dryRun || !writeDomain ? "Would update" : "Updated"}: ${domainResult.updated}`,
      "",
    );
  }

  const candidates = await findDelistCandidates();
  const summary = [formatDelistSummary(candidates), "", ...summaryParts].join("\n");
  console.info(`\n${formatDelistSummary(candidates)}`);

  const summaryPath = path.join(process.cwd(), "delist-summary.md");
  fs.writeFileSync(summaryPath, summary);

  if (candidates.length === 0) {
    console.info("✅ No delist candidates");
    return;
  }

  if (!writeDelist || dryRun) {
    console.info(
      `ℹ️  ${candidates.length} delist candidate(s) — re-run with --write-delist to apply (CI opens a PR)`,
    );
    return;
  }

  const updated = applyDelistCandidates(candidates);
  console.info(`✅ Applied listed:false to ${updated} provider(s); rebuilt all.json`);
}

if (isMain(import.meta.url)) {
  refreshProviders().catch((error) => {
    console.error("❌ Provider refresh failed:", error);
    process.exitCode = 1;
  });
}
