import * as fs from "node:fs";
import * as path from "node:path";
import { applyChainDrift, collectChainDrift, formatChainDriftSummary } from "../chainDrift.js";
import type { ProviderInfo } from "../config.js";
import {
  applyDelistCandidates,
  findDelistCandidates,
  formatDelistSummary,
} from "../earn/delist.js";
import { isMain } from "../isMain.js";
import { type DomainLinkageSyncResult, syncDomainLinkage } from "./syncDomainLinkage.js";
import { formatDualNetworkSection, syncDualNetwork } from "./syncDualNetwork.js";
import {
  applyManagementGroupDrift,
  collectManagementGroupDrift,
  formatManagementGroupSummary,
  type ManagementGroupDrift,
  warnUnknownManagementGroupMembers,
} from "./syncManagementGroup.js";

/**
 * Nightly provider refresh:
 * 1. With --write-domain: persist domainLinked into git (unsigned flag). CI
 *    leaves those edits in the working tree for the nightly/fsp-delist pull
 *    request — never straight to main. The domain-linkage section is also
 *    written to domain-linkage-summary.md so a later --skip-domain run can
 *    keep it in delist-summary.md. Skip the check entirely with --skip-domain.
 * 2. Compute dualNetwork from a shared identity address, a website domain
 *    linked on both Flare and Songbird, or the same normalized name. With
 *    --write-dual-network, persist the flags. The nightly catalog step passes
 *    that flag after domain linkage is on disk, so the pull request summary
 *    counts the edits. --dry-run previews.
 * 3. With --write-delist: flip listed:false for providers that burned FSP
 *    rewards (eligibleForReward=false in the latest passes.json) or whose
 *    current FTSO fee or any currently validating Flare validator fee is above
 *    50% (Bifrost's listing recommendation). CI applies this on the same
 *    branch and opens one PR — never straight to main. Skip the fee scan
 *    entirely with --skip-delist so a domain-only pass does not hit Flare twice.
 * 4. With --write-chain: compare EntityManager addresses and validators with
 *    info.json, and set managementGroup from each network's
 *    PollingManagementGroup. Same PR as domain linkage, dual network, and
 *    delist; signatures stay valid because those fields are unsigned. A failed
 *    chain read aborts the run. On-chain management-group members with no
 *    catalog entry are warned about and are not added. Skip both comparisons
 *    with --skip-chain.
 *
 * Usage:
 *   ./yarn refresh:providers
 *   ./yarn refresh:providers --dry-run
 *   ./yarn refresh:providers --write-domain
 *   ./yarn refresh:providers --write-domain --skip-chain --skip-delist
 *   ./yarn refresh:providers --write-delist --write-chain --write-dual-network --skip-domain
 */

interface RefreshArgs {
  dryRun: boolean;
  writeDomain: boolean;
  writeDelist: boolean;
  writeChain: boolean;
  writeDualNetwork: boolean;
  skipDomain: boolean;
  skipDelist: boolean;
  skipChain: boolean;
}

export function parseArgs(argv: string[]): RefreshArgs {
  return {
    dryRun: argv.includes("--dry-run"),
    writeDomain: argv.includes("--write-domain"),
    writeDelist: argv.includes("--write-delist"),
    writeChain: argv.includes("--write-chain"),
    writeDualNetwork: argv.includes("--write-dual-network"),
    skipDomain: argv.includes("--skip-domain"),
    skipDelist: argv.includes("--skip-delist"),
    skipChain: argv.includes("--skip-chain"),
  };
}

/** Sidecar written by the domain run and read by a later --skip-domain run. */
export const DOMAIN_LINKAGE_SUMMARY_FILE = "domain-linkage-summary.md";

export function formatDomainLinkageSection(
  result: DomainLinkageSyncResult,
  persisted: boolean,
): string {
  const action = persisted ? "Updated" : "Would update";
  return [
    "## Domain linkage",
    "",
    `- Checked: ${result.checked}`,
    `- Linked: ${result.linked}`,
    `- ${action}: ${result.updated}`,
    "",
  ].join("\n");
}

function domainLinkageSummaryPath(directory: string = process.cwd()): string {
  return path.join(directory, DOMAIN_LINKAGE_SUMMARY_FILE);
}

export function writeDomainLinkageSection(
  section: string,
  directory: string = process.cwd(),
): void {
  fs.writeFileSync(domainLinkageSummaryPath(directory), section);
}

/** Prior run's domain section, if that run left a non-empty sidecar. */
export function readCarriedDomainLinkageSection(
  directory: string = process.cwd(),
): string | undefined {
  const summaryPath = domainLinkageSummaryPath(directory);
  if (!fs.existsSync(summaryPath)) return undefined;
  const carried = fs.readFileSync(summaryPath, "utf8");
  if (carried.trim().length === 0) return undefined;
  return carried.endsWith("\n") ? carried : `${carried}\n`;
}

export function buildCatalogRefreshSummary(
  delistSummary: string,
  chainSummary: string,
  domainSection?: string,
  managementGroupSummary?: string,
  dualNetworkSection?: string,
): string {
  const parts = [delistSummary, "", chainSummary, ""];
  if (managementGroupSummary) {
    parts.push(managementGroupSummary, "");
  }
  if (domainSection) parts.push(domainSection);
  if (dualNetworkSection) parts.push(dualNetworkSection);
  return parts.join("\n");
}

async function refreshProviders(): Promise<void> {
  const {
    dryRun,
    writeDomain,
    writeDelist,
    writeChain,
    writeDualNetwork,
    skipDomain,
    skipDelist,
    skipChain,
  } = parseArgs(process.argv.slice(2));

  let domainSection: string | undefined;

  if (skipDomain) {
    console.info("ℹ️  --skip-domain: not checking domain linkage");
    domainSection = readCarriedDomainLinkageSection();
  } else {
    console.info("\n🔗 Domain linkage");
    const domainResult = await syncDomainLinkage({ dryRun: dryRun || !writeDomain });
    if (!writeDomain && !dryRun) {
      console.info(
        "ℹ️  Domain linkage was checked only — re-run with --write-domain to persist domainLinked (CI)",
      );
    }
    domainSection = formatDomainLinkageSection(domainResult, !dryRun && writeDomain);
    // Nightly run 2 passes --skip-domain and rewrites delist-summary.md.
    writeDomainLinkageSection(domainSection);
  }

  // After domain linkage so a domain that just became linked counts this run.
  // The nightly catalog step passes --write-dual-network. An earlier refresh
  // in the same job only previews, so the pull request summary counts the write.
  console.info("\n🔁 Dual network");
  const persistDualNetwork = !dryRun && writeDualNetwork;
  const dualNetworkResult = syncDualNetwork({ dryRun: !persistDualNetwork });
  if (!writeDualNetwork && !dryRun) {
    console.info(
      "ℹ️  Dual network was checked only — re-run with --write-dual-network to persist dualNetwork (CI)",
    );
  }
  const dualNetworkSection = formatDualNetworkSection(
    dualNetworkResult.updated,
    persistDualNetwork,
  );

  const candidates = skipDelist ? [] : await findDelistCandidates();
  if (skipDelist) {
    console.info("ℹ️  --skip-delist: not scanning FSP rewards or delegation fees");
  } else {
    console.info(`\n${formatDelistSummary(candidates)}`);
  }

  let chainDrift: Awaited<ReturnType<typeof collectChainDrift>> = [];
  let managementGroupDrift: ManagementGroupDrift = {
    flips: [],
    unknown: [],
    flareMembers: 0,
    songbirdMembers: 0,
  };
  if (skipChain) {
    console.info(
      "ℹ️  --skip-chain: not comparing EntityManager fields or Management Group membership",
    );
  } else {
    console.info("\n⛓️ Chain fields");
    chainDrift = await collectChainDrift();
    console.info(formatChainDriftSummary(chainDrift));
    console.info("\n📡 Management Group");
    managementGroupDrift = await collectManagementGroupDrift();
    console.info(formatManagementGroupSummary(managementGroupDrift));
    warnUnknownManagementGroupMembers(managementGroupDrift);
  }

  const summary = buildCatalogRefreshSummary(
    formatDelistSummary(candidates, { skipped: skipDelist }),
    formatChainDriftSummary(chainDrift, { skipped: skipChain }),
    domainSection,
    formatManagementGroupSummary(managementGroupDrift, { skipped: skipChain }),
    dualNetworkSection,
  );
  const summaryPath = path.join(process.cwd(), "delist-summary.md");
  fs.writeFileSync(summaryPath, summary);

  if (!skipDelist && candidates.length === 0) {
    console.info("✅ No delist candidates");
  } else if (!skipDelist && (!writeDelist || dryRun)) {
    console.info(
      `ℹ️  ${candidates.length} delist candidate(s) — re-run with --write-delist to apply (CI opens a PR)`,
    );
  } else if (!skipDelist) {
    const updated = applyDelistCandidates(candidates);
    console.info(`✅ Applied listed:false to ${updated} provider(s); rebuilt all.json`);
  }

  if (chainDrift.length === 0) {
    if (!skipChain) {
      console.info("✅ No chain drift");
    }
  } else if (!writeChain || dryRun) {
    console.info(
      `ℹ️  ${chainDrift.length} provider(s) differ from chain — re-run with --write-chain to apply (CI opens a PR)`,
    );
  } else {
    const updated = applyChainDrift(chainDrift);
    console.info(`✅ Applied chain fields to ${updated} provider(s); rebuilt all.json`);
  }

  if (!skipChain && managementGroupDrift.flips.length === 0) {
    console.info("✅ No managementGroup drift");
  } else if (!skipChain && (!writeChain || dryRun)) {
    console.info(
      `ℹ️  ${managementGroupDrift.flips.length} managementGroup flag(s) differ — re-run with --write-chain to apply (CI opens a PR)`,
    );
  } else if (!skipChain) {
    const updated = applyManagementGroupDrift(managementGroupDrift);
    console.info(`✅ Applied managementGroup to ${updated} provider(s); rebuilt all.json`);
  }
}

if (isMain(import.meta.url)) {
  refreshProviders().catch((error) => {
    console.error("❌ Provider refresh failed:", error);
    process.exitCode = 1;
  });
}
