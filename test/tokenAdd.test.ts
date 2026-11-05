import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, mock, test } from "node:test";
import { encodeAbiParameters, getAddress, type Hex } from "viem";
import {
  decodeErc20Decimals,
  decodeErc20String,
  erc20CallData,
  readErc20Metadata,
} from "../src/erc20Metadata.js";
import { ADD_TOKEN_USAGE, addToken, runAddTokenCli } from "../src/script/tokenAdd.js";
import {
  coinGeckoContractUrl,
  convertLogoBytesToWebp,
  fetchTokenLogo,
  trustWalletLogoUrl,
} from "../src/tokenLogo.js";
import { TokenMetadataError } from "../src/tokenSymbols.js";
import { readWebpDimensions } from "../src/webp.js";

const CHAIN = "eip155-1";
const USDC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDED = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function catalogFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "add-token-"));
  const chainDir = path.join(root, "data", "tokens", CHAIN);
  const nativeDir = path.join(chainDir, "native");
  const usdcDir = path.join(chainDir, USDC);
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(usdcDir, { recursive: true });
  const native = {
    name: "Ethereum",
    symbol: "ETH",
    decimals: 18,
    address: null,
    coingeckoId: "ethereum",
    logoURL: `tokens/${CHAIN}/native/logo.webp`,
    logoHash: "11".repeat(32),
  };
  const usdc = {
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    address: USDC,
    coingeckoId: "usd-coin",
    logoURL: `tokens/${CHAIN}/${USDC}/logo.webp`,
    logoHash: "22".repeat(32),
  };
  fs.writeFileSync(path.join(nativeDir, "info.json"), `${JSON.stringify(native, null, 2)}\n`);
  fs.writeFileSync(path.join(usdcDir, "info.json"), `${JSON.stringify(usdc, null, 2)}\n`);
  fs.writeFileSync(path.join(chainDir, "all.json"), `${JSON.stringify([usdc, native], null, 2)}\n`);
  return root;
}

function metadata(overrides: Partial<{ name: string; symbol: string; decimals: number }> = {}) {
  return async () => ({
    name: overrides.name ?? "Wrapped Example",
    symbol: overrides.symbol ?? "WEX",
    decimals: overrides.decimals ?? 6,
  });
}

describe("ERC-20 metadata decoding", () => {
  test("uses the string selectors and keeps internal spaces", async () => {
    assert.equal(erc20CallData("name"), "0x06fdde03");
    assert.equal(erc20CallData("symbol"), "0x95d89b41");
    assert.equal(erc20CallData("decimals"), "0x313ce567");

    const seen: Hex[] = [];
    const meta = await readErc20Metadata(async (data) => {
      seen.push(data);
      if (data === erc20CallData("name")) {
        return encodeAbiParameters([{ type: "string" }], ["  Wrapped Example  "]);
      }
      if (data === erc20CallData("symbol")) {
        return encodeAbiParameters([{ type: "string" }], ["US D"]);
      }
      return encodeAbiParameters([{ type: "uint8" }], [6]);
    });

    assert.deepEqual(seen, [
      erc20CallData("name"),
      erc20CallData("symbol"),
      erc20CallData("decimals"),
    ]);
    assert.deepEqual(meta, { name: "Wrapped Example", symbol: "US D", decimals: 6 });
  });

  test("rejects empty text and bytes32 returns, and keeps a dotted symbol", async () => {
    const mkr = "0x4d4b520000000000000000000000000000000000000000000000000000000000" as Hex;
    assert.throws(
      () => decodeErc20String(mkr, "symbol"),
      (error: unknown) => {
        assert.ok(error instanceof TokenMetadataError);
        assert.match(error.message, /bytes32/);
        assert.match(error.message, /MKR-style/);
        return true;
      },
    );
    assert.throws(() => decodeErc20String("0x1234", "name"), /name\(\) did not return a string/);
    assert.throws(() => decodeErc20Decimals("0x"), /empty response/);

    const blank = encodeAbiParameters([{ type: "string" }], ["   "]);
    await assert.rejects(
      () =>
        readErc20Metadata(async (data) => {
          if (data === erc20CallData("symbol")) return blank;
          if (data === erc20CallData("name")) {
            return encodeAbiParameters([{ type: "string" }], ["Name"]);
          }
          return encodeAbiParameters([{ type: "uint8" }], [18]);
        }),
      /Symbol is empty/,
    );

    const dotted = encodeAbiParameters([{ type: "string" }], ["USD.e"]);
    const dottedMeta = await readErc20Metadata(async (data) => {
      if (data === erc20CallData("symbol")) return dotted;
      if (data === erc20CallData("name")) {
        return encodeAbiParameters([{ type: "string" }], ["Name"]);
      }
      return encodeAbiParameters([{ type: "uint8" }], [18]);
    });
    assert.equal(dottedMeta.symbol, "USD.e");
    assert.equal(dottedMeta.name, "Name");
  });
});

describe("token logo lookup", () => {
  test("uses the CoinGecko contract image and does not call Trust Wallet", async () => {
    const calls: string[] = [];
    const address = ADDED;
    const imageUrl = "https://images.example/logo.png";
    const fetchImpl = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url === coinGeckoContractUrl(1, address)) {
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers["user-agent"], "bifrostwallet-assets/add-token");
        return jsonResponse({
          id: "wrapped-example",
          image: { large: imageUrl, small: "https://images.example/small.png" },
        });
      }
      if (url === imageUrl) return new Response(Uint8Array.from([1, 2, 3]));
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const logo = await fetchTokenLogo({
      chainId: 1,
      address,
      fetchImpl,
      convertLogo: () => Buffer.from("webp"),
    });
    assert.equal(logo.source, "coingecko");
    assert.equal(logo.coingeckoId, "wrapped-example");
    assert.deepEqual(logo.bytes, Buffer.from("webp"));
    assert.deepEqual(calls, [coinGeckoContractUrl(1, address), imageUrl]);
  });

  test("falls back to Trust Wallet when CoinGecko has no icon", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url === coinGeckoContractUrl(1, ADDED)) return jsonResponse({ error: "missing" }, 404);
      if (url === trustWalletLogoUrl(1, ADDED)) return new Response(Uint8Array.from([9]));
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const logo = await fetchTokenLogo({
      chainId: 1,
      address: ADDED,
      fetchImpl,
      convertLogo: (bytes) => Buffer.from(`converted:${bytes.toString("hex")}`),
    });
    assert.equal(logo.source, "trustwallet");
    assert.equal(logo.coingeckoId, null);
    assert.equal(logo.bytes.toString(), "converted:09");
    assert.equal(
      trustWalletLogoUrl(1, ADDED),
      `${"https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/"}${getAddress(ADDED)}/logo.png`,
    );
    assert.deepEqual(calls, [coinGeckoContractUrl(1, ADDED), trustWalletLogoUrl(1, ADDED)]);
  });

  test("keeps the CoinGecko id when only Trust Wallet has an icon", async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = requestUrl(input);
      if (url === coinGeckoContractUrl(1, ADDED)) {
        return jsonResponse({ id: "no-art", image: { large: "" } });
      }
      if (url === trustWalletLogoUrl(1, ADDED)) return new Response(Uint8Array.from([4]));
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const logo = await fetchTokenLogo({
      chainId: 1,
      address: ADDED,
      fetchImpl,
      convertLogo: () => Buffer.from("webp"),
    });
    assert.equal(logo.coingeckoId, "no-art");
    assert.equal(logo.source, "trustwallet");
  });

  test("fails when neither source has a logo", async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = requestUrl(input);
      if (url === coinGeckoContractUrl(14, ADDED) || url === trustWalletLogoUrl(14, ADDED)) {
        return new Response("no", { status: 404 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    await assert.rejects(
      () =>
        fetchTokenLogo({
          chainId: 14,
          address: ADDED,
          fetchImpl,
          convertLogo: () => Buffer.from("x"),
        }),
      /CoinGecko has no icon.*no catalog for this chain/,
    );
    assert.equal(trustWalletLogoUrl(14, ADDED), null);
  });

  test("converts a PNG to 128×128 WebP at most 24 KB when cwebp is installed", () => {
    const which = spawnSync("which", ["cwebp"], { encoding: "utf8" });
    if (which.status !== 0) return;
    const webp = convertLogoBytesToWebp(ONE_PIXEL_PNG);
    const dims = readWebpDimensions(webp);
    assert.equal(dims?.width, 128);
    assert.equal(dims?.height, 128);
    assert.ok(webp.length / 1024 <= 24);
    assert.deepEqual(convertLogoBytesToWebp(webp), webp);
  });
});

describe("add:token", () => {
  test("writes one token from mocked chain data and a CoinGecko logo", async () => {
    const root = catalogFixture();
    const calls: string[] = [];
    const imageUrl = "https://images.example/wex.png";
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url === coinGeckoContractUrl(1, ADDED)) {
        return jsonResponse({ id: "wrapped-example", image: { large: imageUrl } });
      }
      if (url === imageUrl) return new Response(ONE_PIXEL_PNG);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    let reads = 0;

    const token = await addToken({
      chain: `  ${CHAIN}  `,
      address: `0x${ADDED.slice(2).toUpperCase()}`,
      root,
      env: { ETHEREUM_NODE_URL: "http://rpc.test/only-this-token" },
      fetchImpl,
      readMetadata: async (args) => {
        reads += 1;
        assert.equal(args.chainId, 1);
        assert.equal(args.rpcUrl, "http://rpc.test/only-this-token");
        assert.equal(args.address, ADDED);
        return { name: "  Wrapped Example  ", symbol: " US D ", decimals: 6 };
      },
      convertLogo: (bytes) => Buffer.from(`logo:${bytes.length}`),
    });

    assert.equal(reads, 1);
    assert.deepEqual(calls, [coinGeckoContractUrl(1, ADDED), imageUrl]);
    assert.equal(token.symbol, "US D");
    assert.equal(token.name, "Wrapped Example");
    assert.equal(token.coingeckoId, "wrapped-example");
    const dir = path.join(root, "data", "tokens", CHAIN, ADDED);
    const infoText = fs.readFileSync(path.join(dir, "info.json"), "utf8");
    const info = JSON.parse(infoText) as { logoHash: string; logoURL: string; address: string };
    const logo = fs.readFileSync(path.join(dir, "logo.webp"));
    assert.equal(info.logoHash, createHash("sha256").update(logo).digest("hex"));
    assert.equal(info.logoURL, `tokens/${CHAIN}/${ADDED}/logo.webp`);
    assert.equal(info.address, ADDED);
    assert.match(
      infoText,
      /"name":[\s\S]*"symbol":[\s\S]*"decimals":[\s\S]*"address":[\s\S]*"coingeckoId":[\s\S]*"logoURL":[\s\S]*"logoHash":/,
    );
    const aggregate = JSON.parse(
      fs.readFileSync(path.join(root, "data", "tokens", CHAIN, "all.json"), "utf8"),
    ) as { address: string | null; symbol: string }[];
    assert.deepEqual(
      aggregate.map((entry) => entry.address),
      [USDC, ADDED, null],
    );
    assert.equal(aggregate[1]?.symbol, "US D");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("refuses an existing directory, a duplicate symbol, and a missing logo before writing", async () => {
    const root = catalogFixture();
    const target = path.join(root, "data", "tokens", CHAIN, ADDED);
    fs.mkdirSync(target);
    let reads = 0;
    await assert.rejects(
      () =>
        addToken({
          chain: CHAIN,
          address: ADDED,
          root,
          env: { ETHEREUM_NODE_URL: "http://rpc.test" },
          readMetadata: async () => {
            reads += 1;
            return { name: "X", symbol: "X", decimals: 1 };
          },
        }),
      /Token directory already exists: data\/tokens\/eip155-1\/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/,
    );
    assert.equal(reads, 0);
    fs.rmSync(target, { recursive: true, force: true });

    const fetchImpl = (async () => {
      throw new Error("logo fetch should not run");
    }) as typeof fetch;
    await assert.rejects(
      () =>
        addToken({
          chain: CHAIN,
          address: ADDED,
          root,
          env: { ETHEREUM_NODE_URL: "http://rpc.test" },
          fetchImpl,
          readMetadata: metadata({ symbol: "USDC" }),
        }),
      /symbol "USDC" already exists on eip155-1: 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/,
    );
    await assert.rejects(
      () =>
        addToken({
          chain: CHAIN,
          address: ADDED,
          root,
          env: { ETHEREUM_NODE_URL: "http://rpc.test" },
          fetchImpl,
          readMetadata: metadata({ symbol: "ETH" }),
        }),
      /symbol "ETH" already exists on eip155-1: native/,
    );
    await assert.rejects(
      () =>
        addToken({
          chain: CHAIN,
          address: ADDED,
          root,
          env: { ETHEREUM_NODE_URL: "http://rpc.test" },
          fetchImpl,
          readMetadata: metadata({ name: "   " }),
        }),
      /Name is empty after trimming whitespace/,
    );

    const missingLogo = (async (input: Parameters<typeof fetch>[0]) => {
      const url = requestUrl(input);
      if (url === coinGeckoContractUrl(1, ADDED)) return new Response("no", { status: 404 });
      if (url === trustWalletLogoUrl(1, ADDED)) return new Response("no", { status: 404 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    await assert.rejects(
      () =>
        addToken({
          chain: CHAIN,
          address: ADDED,
          root,
          env: { ETHEREUM_NODE_URL: "http://rpc.test" },
          fetchImpl: missingLogo,
          readMetadata: metadata(),
          convertLogo: () => Buffer.from("unused"),
        }),
      /No logo for 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/,
    );
    assert.equal(fs.existsSync(target), false);

    await assert.rejects(
      () =>
        addToken({
          chain: CHAIN,
          address: ADDED,
          root,
          env: {},
          readMetadata: metadata(),
        }),
      /No RPC URL for eip155-1\. Set ETHEREUM_NODE_URL\./,
    );
    await assert.rejects(
      () => addToken({ chain: "eip155:1", address: ADDED, root, env: {} }),
      /Use a catalog chain id such as eip155-1/,
    );
    await assert.rejects(
      () => addToken({ chain: "eip155-16", address: ADDED, root, env: {} }),
      /No RPC env var for eip155-16/,
    );
    await assert.rejects(
      () =>
        addToken({
          chain: CHAIN,
          address: "0x123",
          root,
          env: { ETHEREUM_NODE_URL: "http://rpc.test" },
        }),
      /Invalid contract address/,
    );
    await assert.rejects(
      () =>
        addToken({
          chain: CHAIN,
          address: ADDED,
          root,
          env: { ETHEREUM_NODE_URL: "http://rpc.test" },
          readMetadata: async () => {
            throw new Error("connection refused");
          },
        }),
      /Could not read on-chain name, symbol, and decimals for 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb on eip155-1: connection refused/,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("prints usage and a clear failure from the CLI", async () => {
    const previous = process.exitCode;
    const error = mock.method(console, "error", () => {});
    const info = mock.method(console, "info", () => {});
    try {
      await runAddTokenCli([]);
      assert.equal(process.exitCode, 1);
      assert.equal(error.mock.calls[0]?.arguments[0], ADD_TOKEN_USAGE);

      process.exitCode = 0;
      await runAddTokenCli(["--help"]);
      assert.equal(process.exitCode, 0);
      assert.equal(info.mock.calls.at(-1)?.arguments[0], ADD_TOKEN_USAGE);

      await runAddTokenCli(["eip155-1"]);
      assert.equal(process.exitCode, 1);
    } finally {
      error.mock.restore();
      info.mock.restore();
      process.exitCode = previous;
    }
  });
});
