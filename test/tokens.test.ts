import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { validateEvmToken } from "../src/tokens.js";

const WFLR = "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d";

function evmToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Wrapped Flare",
    symbol: "WFLR",
    decimals: 18,
    address: WFLR,
    coingeckoId: "wrapped-flare",
    logoURL: `tokens/eip155-14/${WFLR}/logo.webp`,
    logoHash: "a".repeat(64),
    ...overrides,
  };
}

describe("EVM token validation", () => {
  test("keeps the lowercase address rule and ignores unknown fields", () => {
    assert.deepEqual(validateEvmToken(evmToken()), []);
    assert.deepEqual(
      validateEvmToken(evmToken({ address: null, name: "Flare", symbol: "FLR" })),
      [],
    );
    assert.ok(
      validateEvmToken(evmToken({ address: "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d" })).some(
        (error) => error.includes("lowercase 0x"),
      ),
    );
    assert.deepEqual(validateEvmToken(evmToken({ extra: true })), []);
    assert.ok(
      validateEvmToken(evmToken({ decimals: -1 })).some((error) => error === "invalid decimals"),
    );
  });
});
