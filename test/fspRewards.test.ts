import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ELIGIBILITY,
  type EpochEntity,
  evaluateEligibility,
  type ParsedEpochInfo,
} from "../src/fspRewards.js";

function entity(
  identity: string,
  opts: { signingWeight?: string | null; wNatWeight?: string | null } = {},
): EpochEntity {
  return {
    identity,
    delegationAddress: null,
    submitAddress: null,
    submitSignaturesAddress: null,
    signingPolicyAddress: null,
    nodeIds: [],
    feeBips: null,
    wNatWeight: opts.wNatWeight === undefined ? "1" : opts.wNatWeight,
    wNatCappedWeight: null,
    signingWeight: opts.signingWeight === undefined ? "1" : opts.signingWeight,
  };
}

function windowWithPresence(
  identity: string,
  presentMask: boolean[],
  latestOverrides: { signingWeight?: string | null; wNatWeight?: string | null } = {},
): ParsedEpochInfo[] {
  return presentMask.map((present, index) => ({
    epochId: presentMask.length - index,
    entities: present
      ? [entity(identity, index === 0 ? latestOverrides : { signingWeight: "1", wNatWeight: "1" })]
      : [],
  }));
}

describe("evaluateEligibility (advisory check:providers)", () => {
  const identity = "0xabc";

  it("is eligible with full window, signing weight, and vote power", () => {
    const window = windowWithPresence(identity, Array(ELIGIBILITY.UPTIME_WINDOW_EPOCHS).fill(true));
    const checks = evaluateEligibility(identity, window);
    assert.equal(checks.eligible, true);
    assert.equal(checks.uptime, true);
  });

  it("is not eligible after a single latest-epoch miss when uptime still passes", () => {
    // 8/9 present = ~88.9% < 95% threshold — fails uptime
    const mask = [false, ...Array(ELIGIBILITY.UPTIME_WINDOW_EPOCHS - 1).fill(true)];
    const checks = evaluateEligibility(identity, windowWithPresence(identity, mask));
    assert.equal(checks.submitting, false);
    assert.equal(checks.eligible, false);
  });

  it("fails uptime when any epoch in the 9-wide window is missing (8/9 < 0.95)", () => {
    const mask = [...Array(ELIGIBILITY.UPTIME_WINDOW_EPOCHS - 1).fill(true), false];
    const checks = evaluateEligibility(identity, windowWithPresence(identity, mask));
    assert.equal(checks.presentEpochs, ELIGIBILITY.UPTIME_WINDOW_EPOCHS - 1);
    assert.equal(checks.uptime, false);
    assert.equal(checks.eligible, false);
  });

  it("fails when latest epoch has no signing weight", () => {
    const window = windowWithPresence(
      identity,
      Array(ELIGIBILITY.UPTIME_WINDOW_EPOCHS).fill(true),
      { signingWeight: null },
    );
    const checks = evaluateEligibility(identity, window);
    assert.equal(checks.submitting, false);
    assert.equal(checks.votePower, false);
    assert.equal(checks.eligible, false);
  });

  it("does not mark eligible when the window is incomplete (uptime null)", () => {
    const window = windowWithPresence(identity, [true, true, true]);
    const checks = evaluateEligibility(identity, window);
    assert.equal(checks.uptime, null);
    assert.equal(checks.eligible, false);
  });
});
