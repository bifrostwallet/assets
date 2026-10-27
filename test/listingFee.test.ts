import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bipsExceedListingCap,
  delegationFeePercentExceedsListingCap,
  formatFeeDelistReason,
  type ListingFeeObservation,
} from "../src/earn/listingFee.js";

function observation(overrides: Partial<ListingFeeObservation> = {}): ListingFeeObservation {
  return {
    ftsoFeeBips: 2_000,
    validatingNodes: [],
    ...overrides,
  };
}

describe("delegation fee listing cap (Bifrost recommendation)", () => {
  it("keeps a fee of exactly 50%", () => {
    assert.equal(bipsExceedListingCap(5_000), false);
    assert.equal(delegationFeePercentExceedsListingCap("50.0000"), false);
    assert.equal(
      formatFeeDelistReason(
        observation({
          ftsoFeeBips: 5_000,
          validatingNodes: [{ nodeId: "NodeID-cap", delegationFee: "50.0000" }],
        }),
      ),
      null,
    );
  });

  it("delists a fee of 50.01%", () => {
    assert.equal(bipsExceedListingCap(5_001), true);
    assert.equal(delegationFeePercentExceedsListingCap("50.0100"), true);
    const ftso = formatFeeDelistReason(
      observation({
        ftsoFeeBips: 5_001,
        validatingNodes: [{ nodeId: "NodeID-cap", delegationFee: "50.0000" }],
      }),
    );
    assert.ok(ftso);
    assert.match(ftso, /50\.01%/);
    assert.match(ftso, /5001 bips/);

    const validator = formatFeeDelistReason(
      observation({
        ftsoFeeBips: 5_000,
        validatingNodes: [{ nodeId: "NodeID-over", delegationFee: "50.0100" }],
      }),
    );
    assert.ok(validator);
    assert.match(validator, /NodeID-over/);
    assert.match(validator, /50\.0100%/);
  });

  it("delists the whole operator when only a validator fee is above 50%", () => {
    const reason = formatFeeDelistReason(
      observation({
        ftsoFeeBips: 2_000,
        validatingNodes: [
          { nodeId: "NodeID-ok", delegationFee: "20.0000" },
          { nodeId: "NodeID-high", delegationFee: "100.0000" },
        ],
      }),
    );
    assert.ok(reason);
    assert.match(reason, /NodeID-high/);
    assert.match(reason, /100\.0000%/);
    assert.doesNotMatch(reason, /FTSO\/FSP/);
    assert.doesNotMatch(reason, /NodeID-ok/);
  });

  it("delists when the FTSO fee is above 50% and validators are within the cap", () => {
    const reason = formatFeeDelistReason(
      observation({
        ftsoFeeBips: 10_000,
        validatingNodes: [{ nodeId: "NodeID-ok", delegationFee: "20.0000" }],
      }),
    );
    assert.ok(reason);
    assert.match(reason, /FTSO\/FSP delegation fee 100%/);
    assert.doesNotMatch(reason, /NodeID-ok/);
  });

  it("allows fees below the usual 20%", () => {
    assert.equal(bipsExceedListingCap(0), false);
    assert.equal(bipsExceedListingCap(1_000), false);
    assert.equal(delegationFeePercentExceedsListingCap("7.5000"), false);
    assert.equal(
      formatFeeDelistReason(
        observation({
          ftsoFeeBips: 0,
          validatingNodes: [{ nodeId: "NodeID-low", delegationFee: "7.5000" }],
        }),
      ),
      null,
    );
  });

  it("ignores a validator that is not currently validating", () => {
    assert.equal(
      formatFeeDelistReason(
        observation({
          ftsoFeeBips: 2_000,
          validatingNodes: [],
        }),
      ),
      null,
    );
  });
});
