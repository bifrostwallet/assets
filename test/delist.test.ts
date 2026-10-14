import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPassReason, isDelistCandidate } from "../src/earn/delist.js";
import type { FspPassRecord } from "../src/earn/github.js";

function record(overrides: Partial<FspPassRecord> = {}): FspPassRecord {
  return {
    rewardEpochId: 416,
    dataProviderName: "Example FTSO",
    voterAddress: "0xabc",
    passes: 3,
    eligibleForReward: true,
    failures: [],
    ...overrides,
  };
}

describe("isDelistCandidate (FSP passes delist gate)", () => {
  it("does not delist a provider that kept reward eligibility", () => {
    assert.equal(isDelistCandidate(record()), false);
  });

  it("does not delist on a lost pass while still reward-eligible", () => {
    const lostOnePass = record({
      passes: 2,
      failures: [{ protocolId: 200, failureId: "FDC_FAILURE" }],
    });
    assert.equal(isDelistCandidate(lostOnePass), false);
  });

  it("does not delist at zero passes while still reward-eligible", () => {
    assert.equal(isDelistCandidate(record({ passes: 0 })), false);
  });

  it("delists when rewards were burned (eligibleForReward=false)", () => {
    const burned = record({
      passes: 0,
      eligibleForReward: false,
      failures: [{ protocolId: 200, failureId: "FDC_FAILURE" }],
    });
    assert.equal(isDelistCandidate(burned), true);
  });

  it("does not delist providers absent from passes.json", () => {
    assert.equal(isDelistCandidate(undefined), false);
  });
});

describe("formatPassReason", () => {
  it("includes epoch, pass count, and failure ids", () => {
    const reason = formatPassReason(
      record({
        passes: 0,
        eligibleForReward: false,
        failures: [
          { protocolId: 100, failureId: "FTSO_SCALING_FAILURE" },
          { protocolId: 200, failureId: "FDC_FAILURE" },
        ],
      }),
    );
    assert.equal(
      reason,
      "FSP rewards burned in epoch 416 (passes=0; FTSO_SCALING_FAILURE, FDC_FAILURE)",
    );
  });

  it("handles empty failures", () => {
    const reason = formatPassReason(record({ eligibleForReward: false, passes: 0 }));
    assert.equal(reason, "FSP rewards burned in epoch 416 (passes=0; unspecified failure)");
  });
});
