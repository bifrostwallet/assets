import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CHAIN_READ_CONCURRENCY,
  diffProviderChainFields,
  formatChainDriftSummary,
} from "../src/chainDrift.js";
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

describe("chain read concurrency", () => {
  test("Flare EntityManager reads stay at two in flight", () => {
    assert.equal(CHAIN_READ_CONCURRENCY, 2);
  });
});

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

describe("formatChainDriftSummary", () => {
  test("says nothing differs when the comparison ran and matched", () => {
    assert.equal(
      formatChainDriftSummary([]),
      "No provider chain fields differ from EntityManager.\n",
    );
  });

  test("says the comparison was skipped instead of claiming a match", () => {
    assert.equal(formatChainDriftSummary([], { skipped: true }), "Chain comparison was skipped.\n");
    assert.equal(
      formatChainDriftSummary([], { skipped: true }).includes("No provider chain fields differ"),
      false,
    );
  });

  test("skipped comparison does not list drift from a previous read", () => {
    const summary = formatChainDriftSummary(
      [
        {
          chainPath: "flare",
          identityAddress: "0xabc",
          name: "Example",
          infoPath: "unused",
          changes: [{ field: "publicKey", catalog: "0x1", chain: "0x2" }],
          observed: {},
        },
      ],
      { skipped: true },
    );
    assert.equal(summary, "Chain comparison was skipped.\n");
  });

  test("lists each drifted field", () => {
    const summary = formatChainDriftSummary([
      {
        chainPath: "flare",
        identityAddress: "0xabc",
        name: "Example",
        infoPath: "unused",
        changes: [{ field: "delegationAddress", catalog: "", chain: "0x999" }],
        observed: {},
      },
    ]);
    assert.equal(
      summary,
      `${[
        "Chain drift — EntityManager differs from info.json for unsigned fields",
        "(delegation, submit, signing policy, public key, validators).",
        "",
        "Merging applies the chain values. Signatures stay valid because these fields are unsigned.",
        "",
        "- **Example** (`0xabc`, flare)",
        "  - `delegationAddress`: `(empty)` → `0x999`",
      ].join("\n")}\n`,
    );
  });
});
