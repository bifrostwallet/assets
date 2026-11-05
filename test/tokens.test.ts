import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  duplicateSymbolErrors,
  duplicateSymbolGroups,
  GRANDFATHERED_DUPLICATE_SYMBOLS,
  listEvmSymbolUses,
  type SymbolUse,
} from "../src/tokenSymbols.js";
import { type EvmToken, insertEvmToken, validateEvmToken } from "../src/tokens.js";

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
    assert.deepEqual(validateEvmToken(evmToken({ symbol: "USD Coin" })), []);
    assert.deepEqual(validateEvmToken(evmToken({ symbol: "USD.e" })), ['symbol contains "."']);
  });
});

describe("EVM symbol uniqueness", () => {
  test("allows the grandfathered duplicates and rejects a new one", () => {
    const uses = listEvmSymbolUses();
    assert.deepEqual(duplicateSymbolErrors(uses), []);

    const expected: { chainPath: string; symbol: string; ids: string[] }[] = [];
    for (const [chainPath, symbols] of Object.entries(GRANDFATHERED_DUPLICATE_SYMBOLS)) {
      for (const [symbol, ids] of Object.entries(symbols)) {
        expected.push({ chainPath, symbol, ids: [...ids] });
      }
    }
    assert.deepEqual(duplicateSymbolGroups(uses), expected);

    const extra: SymbolUse = {
      chainPath: "eip155-1",
      symbol: "USDP",
      id: "0x0000000000000000000000000000000000000001",
    };
    assert.ok(duplicateSymbolErrors([...uses, extra]).length > 0);

    const fresh: SymbolUse[] = [
      { chainPath: "eip155-1", symbol: "USDC", id: "0x0000000000000000000000000000000000000002" },
      { chainPath: "eip155-1", symbol: "USDC", id: "0x0000000000000000000000000000000000000003" },
    ];
    assert.match(duplicateSymbolErrors(fresh).join("\n"), /USDC/);
  });
});

describe("EVM aggregate insert", () => {
  test("keeps existing order and places the new address before native", () => {
    const native = evmToken({
      name: "Ethereum",
      symbol: "ETH",
      address: null,
      coingeckoId: "ethereum",
    }) as EvmToken;
    const low = evmToken({
      address: "0x000000000000000000000000000000000000000a",
      symbol: "A",
    }) as EvmToken;
    const high = evmToken({
      address: "0x000000000000000000000000000000000000000c",
      symbol: "C",
    }) as EvmToken;
    const added = evmToken({
      address: "0x000000000000000000000000000000000000000b",
      symbol: "B",
    }) as EvmToken;
    const next = insertEvmToken([low, high, native], added);
    assert.deepEqual(
      next.map((token) => token.address),
      [low.address, added.address, high.address, null],
    );
  });
});
