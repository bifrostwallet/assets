// Parser for the Flare-published fsp-rewards dataset
// (github.com/flare-foundation/fsp-rewards, folders flare/<epoch> and songbird/<epoch>).
// Pure parsing helpers adapted from the MIT-licensed BurstLabs/flareregistry
// (src/lib/fsp-rewards.ts); fetching is done by the calling script.

export interface EpochEntity {
  /** Lowercased identity (voter) address — the canonical provider key */
  identity: string;
  delegationAddress: string | null;
  submitAddress: string | null;
  submitSignaturesAddress: string | null;
  signingPolicyAddress: string | null;
  nodeIds: string[];
  feeBips: number | null;
  wNatWeight: string | null;
  wNatCappedWeight: string | null;
  signingWeight: string | null;
}

export interface ParsedEpochInfo {
  epochId: number;
  entities: EpochEntity[];
}

function lower(value: unknown): string | null {
  return typeof value === "string" && value ? value.toLowerCase() : null;
}

/**
 * Parses one reward-epoch-info.json into per-entity registration data.
 * signingPolicy.voters[i] are SIGNING-POLICY addresses; weights[i] is that
 * entity's signing weight, resolved back to identity via voterRegistrationInfo.
 */
// biome-ignore lint/suspicious/noExplicitAny: external JSON shape
export function parseEpochInfo(info: any): ParsedEpochInfo {
  const epochId: number = info.rewardEpochId;

  const signingPolicyAddrs: string[] = (info.signingPolicy?.voters ?? []).map((voter: string) =>
    voter.toLowerCase(),
  );
  const signingWeights: (number | string)[] = info.signingPolicy?.weights ?? [];
  const signingWeightByPolicyAddr = new Map<string, string>();
  signingPolicyAddrs.forEach((address, index) => {
    const weight = signingWeights[index];
    if (weight !== undefined) {
      signingWeightByPolicyAddr.set(address, String(weight));
    }
  });

  const entities: EpochEntity[] = [];
  for (const entry of info.voterRegistrationInfo ?? []) {
    const registered = entry.voterRegistered ?? {};
    const registrationInfo = entry.voterRegistrationInfo ?? {};
    const identity = lower(registered.voter ?? registrationInfo.voter);
    if (!identity) continue;

    const signingPolicyAddress = lower(registered.signingPolicyAddress);
    entities.push({
      identity,
      delegationAddress: lower(registrationInfo.delegationAddress),
      submitAddress: lower(registered.submitAddress),
      submitSignaturesAddress: lower(registered.submitSignaturesAddress),
      signingPolicyAddress,
      nodeIds: Array.isArray(registrationInfo.nodeIds)
        ? registrationInfo.nodeIds.map((nodeId: string) => nodeId.toLowerCase())
        : [],
      feeBips:
        typeof registrationInfo.delegationFeeBIPS === "number"
          ? registrationInfo.delegationFeeBIPS
          : null,
      wNatWeight: registrationInfo.wNatWeight != null ? String(registrationInfo.wNatWeight) : null,
      wNatCappedWeight:
        registrationInfo.wNatCappedWeight != null
          ? String(registrationInfo.wNatCappedWeight)
          : null,
      signingWeight: signingWeightByPolicyAddr.get(signingPolicyAddress ?? "") ?? null,
    });
  }

  return { epochId, entities };
}

/** Eligibility thresholds mirroring flareregistry qualification defaults */
export const ELIGIBILITY = {
  /** ~30 days at 3.5-day reward epochs */
  UPTIME_WINDOW_EPOCHS: 9,
  UPTIME_THRESHOLD: 0.95,
} as const;

export interface EligibilityChecks {
  identity: string;
  presentEpochs: number;
  windowEpochs: number;
  submitting: boolean;
  votePower: boolean;
  uptime: boolean | null; // null = insufficient history
  eligible: boolean;
}

/**
 * Evaluates eligibility for one identity across a window of parsed epochs
 * (most recent first).
 */
export function evaluateEligibility(
  identity: string,
  window: ParsedEpochInfo[],
): EligibilityChecks {
  const inEpoch = (epoch: ParsedEpochInfo) =>
    epoch.entities.find((entity) => entity.identity === identity);

  const latest = window[0] ? inEpoch(window[0]) : undefined;
  const presentEpochs = window.filter((epoch) => inEpoch(epoch)).length;

  const submitting = latest != null && latest.signingWeight != null;
  const votePower =
    latest != null &&
    latest.wNatWeight != null &&
    BigInt(latest.wNatWeight) > 0n &&
    latest.signingWeight != null;

  let uptime: boolean | null = null;
  if (window.length >= ELIGIBILITY.UPTIME_WINDOW_EPOCHS) {
    uptime = presentEpochs / window.length >= ELIGIBILITY.UPTIME_THRESHOLD;
  }

  return {
    identity,
    presentEpochs,
    windowEpochs: window.length,
    submitting,
    votePower,
    uptime,
    eligible: submitting && votePower && uptime === true,
  };
}
