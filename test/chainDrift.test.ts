import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { diffProviderChainFields } from "../src/chainDrift.js";
import type { ProviderInfo } from "../src/config.js";

const catalog = {
  name: "Example",
  identityAddress: "0xabc",
  delegationAddress: "0x111",
  signingPolicyAddress: "0x222",
  submitAddress: "0x333",
  submitSignaturesAddress: "0x444",
  publicKey: `0x${"a".repeat(128)}`,
  validators: ["NodeID-B", "NodeID-A"],
} as ProviderInfo;

describe("diffProviderChainFields", () => {
  test("ignores chain fields the read did not return", () => {
    assert.deepEqual(diffProviderChainFields(catalog, {}), []);
  });

  test("reports address, key, and validator drift", () => {
    const changes = diffProviderChainFields(catalog, {
      delegationAddress: "0x999",
      validators: ["NodeID-C"],
      publicKey: `0x${"b".repeat(128)}`,
    });
    assert.deepEqual(
      changes.map((change) => change.field),
      ["delegationAddress", "publicKey", "validators"],
    );
  });

  test("treats validator order as the same set", () => {
    const changes = diffProviderChainFields(catalog, {
      validators: ["NodeID-A", "NodeID-B"],
    });
    assert.deepEqual(changes, []);
  });
});
