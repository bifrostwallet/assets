import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { DEFAULT_ASSET_BASE_URL } from "../src/config.js";
import { buildTokensAllJson, rebuildTokensAllJson } from "../src/convert.js";
import {
  duplicateSymbolErrors,
  duplicateSymbolGroups,
  GRANDFATHERED_DUPLICATE_SYMBOLS,
  listEvmSymbolUses,
  type SymbolUse,
} from "../src/tokenSymbols.js";
import {
  type EvmToken,
  insertEvmToken,
  listTokenChainPaths,
  validateEvmToken,
} from "../src/tokens.js";
import { XRPL_MAINNET_CHAIN_PATH, type XrplToken } from "../src/xrplToken.js";

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
    assert.deepEqual(validateEvmToken(evmToken({ symbol: "USD.e" })), []);
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

describe("token all.json", () => {
  test("matches the rebuild helper and uses absolute GitHub logoURL", () => {
    const chains = listTokenChainPaths();
    assert.ok(chains.length > 0);
    for (const chainPath of chains) {
      const allPath = path.join(process.cwd(), "data", "tokens", chainPath, "all.json");
      const all = JSON.parse(fs.readFileSync(allPath, "utf8")) as { logoURL: string }[];
      assert.deepEqual(all, buildTokensAllJson(chainPath), chainPath);
      assert.ok(all.length > 0, chainPath);
      for (const entry of all) {
        assert.equal(
          entry.logoURL.startsWith(`${DEFAULT_ASSET_BASE_URL}tokens/${chainPath}/`),
          true,
          entry.logoURL,
        );
      }
    }
  });

  test("rebuild keeps info.json relative and does not double-prefix an absolute logoURL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-all-"));
    const chain = "eip155-14";
    const address = `0x${"ab".repeat(20)}`;
    const nativeDir = path.join(root, "data", "tokens", chain, "native");
    const tokenDir = path.join(root, "data", "tokens", chain, address);
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.mkdirSync(tokenDir, { recursive: true });
    const nativeLogo = `tokens/${chain}/native/logo.webp`;
    const tokenLogo = `tokens/${chain}/${address}/logo.webp`;
    const native = {
      name: "Flare",
      symbol: "FLR",
      decimals: 18,
      address: null,
      coingeckoId: "flare-networks",
      logoURL: nativeLogo,
      logoHash: "11".repeat(32),
    };
    const token = {
      name: "Wrapped",
      symbol: "WFLR",
      decimals: 18,
      address,
      coingeckoId: null,
      logoURL: tokenLogo,
      logoHash: "22".repeat(32),
    };
    fs.writeFileSync(path.join(nativeDir, "info.json"), `${JSON.stringify(native)}\n`);
    fs.writeFileSync(path.join(tokenDir, "info.json"), `${JSON.stringify(token)}\n`);

    rebuildTokensAllJson(chain, root);
    const allPath = path.join(root, "data", "tokens", chain, "all.json");
    const all = JSON.parse(fs.readFileSync(allPath, "utf8")) as {
      address: string | null;
      logoURL: string;
    }[];
    assert.deepEqual(
      all.map((entry) => entry.address),
      [address, null],
    );
    assert.equal(all[0]?.logoURL, `${DEFAULT_ASSET_BASE_URL}${tokenLogo}`);
    assert.equal(all[1]?.logoURL, `${DEFAULT_ASSET_BASE_URL}${nativeLogo}`);
    const info = JSON.parse(fs.readFileSync(path.join(tokenDir, "info.json"), "utf8")) as {
      logoURL: string;
    };
    assert.equal(info.logoURL, tokenLogo);

    fs.writeFileSync(
      path.join(tokenDir, "info.json"),
      `${JSON.stringify({ ...token, logoURL: all[0]?.logoURL })}\n`,
    );
    rebuildTokensAllJson(chain, root);
    const again = JSON.parse(fs.readFileSync(allPath, "utf8")) as { logoURL: string }[];
    assert.equal(again[0]?.logoURL, all[0]?.logoURL);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("XRPL aggregate is issuer then currency with one absolute logoURL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-xrpl-"));
    const chain = XRPL_MAINNET_CHAIN_PATH;
    const write = (issuer: string, currency: string) => {
      const dir = path.join(root, "data", "tokens", chain, issuer, currency);
      fs.mkdirSync(dir, { recursive: true });
      const info: XrplToken = {
        name: currency,
        symbol: currency,
        issuer,
        currency,
        coingeckoId: null,
        logoURL: `tokens/${chain}/${issuer}/${currency}/logo.webp`,
        logoHash: "aa".repeat(32),
      };
      fs.writeFileSync(path.join(dir, "info.json"), `${JSON.stringify(info)}\n`);
    };
    write("rB", "USD");
    write("rA", "ETH");
    write("rA", "BTC");
    const all = buildTokensAllJson(chain, root) as XrplToken[];
    assert.deepEqual(
      all.map((entry) => `${entry.issuer}/${entry.currency}`),
      ["rA/BTC", "rA/ETH", "rB/USD"],
    );
    assert.equal(all[0]?.logoURL, `${DEFAULT_ASSET_BASE_URL}tokens/${chain}/rA/BTC/logo.webp`);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
