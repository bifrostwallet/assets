import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderInfo } from "../config.js";
import { rebuildProvidersAllJson, sortProviderInfo, writeFormattedJson } from "../convert.js";
import { CHAINS } from "./config.js";
import { type FspPassRecord, loadLatestFspPasses } from "./github.js";
import { formatFeeDelistReason, loadFeeObservations } from "./listingFee.js";

export interface DelistCandidate {
  chainPath: string;
  identityAddress: string;
  name: string;
  reason: string;
  fspEpochId: number;
}

function loadCuratedProviders(chainPath: string): ProviderInfo[] {
  const allPath = path.join(process.cwd(), "data", "providers", chainPath, "all.json");
  if (!fs.existsSync(allPath)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(allPath, "utf8")) as ProviderInfo[];
}

/**
 * Delist gate: the provider burned all FSP rewards for the epoch — zero passes
 * held and another minimal-condition failure (FTSO / FDC / staking, FIP.10 +
 * FIP.12). Losing a pass while still reward-eligible is not enough.
 */
export function isDelistCandidate(record: FspPassRecord | undefined): record is FspPassRecord {
  return record != null && record.eligibleForReward === false;
}

/** Human-readable delist reason from a passes.json record. */
export function formatPassReason(record: FspPassRecord): string {
  const failures =
    record.failures.length > 0
      ? record.failures.map((failure) => failure.failureId).join(", ")
      : "unspecified failure";
  return `FSP rewards burned in epoch ${record.rewardEpochId} (passes=${record.passes}; ${failures})`;
}

/**
 * Listed providers to suggest for `listed: false`:
 * - latest passes.json has `eligibleForReward: false` (absence from
 *   passes.json is left to curators / `check:providers` — never auto-delisted
 *   for that), or
 * - the current FTSO/FSP fee, or any currently validating Flare validator fee,
 *   is above Bifrost's 50% listing cap.
 */
export async function findDelistCandidates(): Promise<DelistCandidate[]> {
  const candidates: DelistCandidate[] = [];

  for (const chain of CHAINS) {
    const { epochId, passes } = await loadLatestFspPasses(chain.name);
    const recordByIdentity = new Map(
      passes.map((record) => [record.voterAddress.toLowerCase(), record]),
    );
    const curated = loadCuratedProviders(chain.chainPath);
    const listed = curated.filter((provider) => provider.listed);
    const fees = await loadFeeObservations(chain, listed);

    for (const provider of listed) {
      const identity = provider.identityAddress.toLowerCase();
      const record = recordByIdentity.get(identity);
      const reasons: string[] = [];
      if (isDelistCandidate(record)) reasons.push(formatPassReason(record));
      const feeReason = formatFeeDelistReason(
        fees.get(identity) ?? { ftsoFeeBips: null, validatingNodes: [] },
      );
      if (feeReason) reasons.push(feeReason);
      if (reasons.length === 0) continue;

      candidates.push({
        chainPath: chain.chainPath,
        identityAddress: identity,
        name: provider.name,
        reason: reasons.join("; "),
        fspEpochId: epochId,
      });
    }
  }

  return candidates;
}

/** Flip listed:false for candidates and rebuild affected all.json files. */
export function applyDelistCandidates(candidates: DelistCandidate[]): number {
  const chainsTouched = new Set<string>();
  let updated = 0;

  for (const candidate of candidates) {
    const infoPath = path.join(
      process.cwd(),
      "data",
      "providers",
      candidate.chainPath,
      candidate.identityAddress,
      "info.json",
    );
    if (!fs.existsSync(infoPath)) {
      console.warn(`⚠️ Skipping missing info.json for ${candidate.identityAddress}`);
      continue;
    }

    const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
    if (!info.listed) continue;

    info.listed = false;
    writeFormattedJson(infoPath, sortProviderInfo(info));
    chainsTouched.add(candidate.chainPath);
    updated++;
  }

  for (const chainPath of chainsTouched) {
    rebuildProvidersAllJson(chainPath);
  }

  return updated;
}

export function formatDelistSummary(candidates: DelistCandidate[]): string {
  if (candidates.length === 0) {
    return "No listed providers burned FSP rewards or charge a delegation fee above Bifrost's 50% listing cap.";
  }

  const lines = [
    "Automated delist candidates. Nightly refresh opens a pull request with",
    "`listed: false`; curators review before merge. A listed operator is included when either:",
    "",
    "- FSP rewards were burned (`eligibleForReward: false` in the latest fsp-rewards",
    "  passes.json: zero passes plus another minimal-condition failure across FTSO / FDC / staking), or",
    "- Bifrost's own listing recommendation (not a protocol rule): the current FTSO/FSP",
    "  delegation fee is above 50%, or any currently validating Flare P-chain node in",
    "  `validators` charges a delegation fee above 50%. Exactly 50% is allowed. 20% is the",
    "  usual fee; lower fees stay listed. Songbird has no P-chain staking.",
    "",
  ];

  for (const candidate of candidates) {
    lines.push(
      `- **${candidate.name}** (\`${candidate.identityAddress}\`, ${candidate.chainPath}): ${candidate.reason}`,
    );
  }

  return `${lines.join("\n")}\n`;
}
