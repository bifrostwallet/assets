import * as fs from "node:fs";
import * as path from "node:path";
import type { Hex } from "viem";
import { sha256Hex, writeFormattedJson } from "../convert.js";
import { type Erc20Metadata, readErc20MetadataFromRpc } from "../erc20Metadata.js";
import {
  chainIdFromPath,
  rpcEnvNameForChain,
  rpcUrlForChain,
  supportedTokenRpcChains,
} from "../evmRpc.js";
import { isMain } from "../isMain.js";
import { fetchTokenLogo } from "../tokenLogo.js";
import { assertCuratedName, assertCuratedSymbol, TokenMetadataError } from "../tokenSymbols.js";
import {
  type EvmToken,
  insertEvmToken,
  listTokenDirs,
  loadEvmToken,
  sortEvmToken,
} from "../tokens.js";
import { isValidEvmAddress } from "../validate.js";

/**
 * Add one EVM token from a chain id and a contract address.
 *
 *   ./yarn add:token eip155-1 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984
 *
 * Reads name, symbol, and decimals for that contract only. Logos come from
 * CoinGecko, then Trust Wallet. Does not scan the rest of the catalog on-chain.
 */

export const ADD_TOKEN_USAGE = `Usage: ./yarn add:token <chain> <address>
Example: ./yarn add:token eip155-1 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984`;

export type AddTokenInput = {
  chain: string;
  address: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readMetadata?: (args: {
    chainId: number;
    rpcUrl: string;
    address: Hex;
  }) => Promise<Erc20Metadata>;
  convertLogo?: (bytes: Buffer) => Buffer;
};

type SymbolHit = { symbol: string; id: string };

function symbolsOnChain(root: string, chainPath: string): SymbolHit[] {
  const found: SymbolHit[] = [];
  for (const { dirName, dir } of listTokenDirs(chainPath, root)) {
    const info = loadEvmToken(path.join(dir, "info.json"));
    if (typeof info.symbol !== "string") continue;
    const id = dirName === "native" || info.address === null ? "native" : info.address;
    found.push({ symbol: info.symbol, id });
  }
  return found;
}

function assertNewSymbol(chainPath: string, symbol: string, existing: readonly SymbolHit[]): void {
  const matches = existing.filter((entry) => entry.symbol === symbol);
  if (matches.length === 0) return;
  const where = matches.map((entry) => entry.id).join(", ");
  throw new Error(
    `A token with symbol ${JSON.stringify(symbol)} already exists on ${chainPath}: ${where}.`,
  );
}

function readAggregate(allPath: string): EvmToken[] {
  if (!fs.existsSync(allPath)) return [];
  const parsed: unknown = JSON.parse(fs.readFileSync(allPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path.basename(path.dirname(allPath))}/all.json is not an array`);
  }
  return parsed as EvmToken[];
}

export async function addToken(input: AddTokenInput): Promise<EvmToken> {
  const root = input.root ?? process.cwd();
  const env = input.env ?? process.env;
  const chain = input.chain.trim();
  const addressInput = input.address.trim();

  console.info("-------------------------------------------------");
  console.info("➕ Adding a token to Bifrost Wallet assets");
  console.info("-------------------------------------------------");

  if (!/^eip155-\d+$/.test(chain)) {
    throw new Error(
      `Unsupported chain ${JSON.stringify(chain)}. Use a catalog chain id such as eip155-1.`,
    );
  }
  const chainId = chainIdFromPath(chain);
  const envName = chainId === null ? undefined : rpcEnvNameForChain(chainId);
  if (chainId === null || !envName) {
    const supported = supportedTokenRpcChains()
      .map((entry) => `${entry.chainPath} (${entry.envName})`)
      .join(", ");
    throw new Error(`No RPC env var for ${chain}. Supported chains: ${supported}.`);
  }
  if (!isValidEvmAddress(addressInput)) {
    throw new Error(
      `Invalid contract address ${JSON.stringify(addressInput)}. Expected a 0x address (40 hex characters).`,
    );
  }

  const address = addressInput.toLowerCase() as Hex;
  const outputDir = path.join(root, "data", "tokens", chain, address);
  if (fs.existsSync(outputDir)) {
    throw new Error(`Token directory already exists: ${path.relative(root, outputDir)}`);
  }

  const rpcUrl = rpcUrlForChain(chainId, env);
  if (!rpcUrl) {
    throw new Error(`No RPC URL for ${chain}. Set ${envName}.`);
  }

  let metadata: Erc20Metadata;
  try {
    metadata = input.readMetadata
      ? await input.readMetadata({ chainId, rpcUrl, address })
      : await readErc20MetadataFromRpc(chainId, rpcUrl, address);
  } catch (error) {
    if (error instanceof TokenMetadataError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read on-chain name, symbol, and decimals for ${address} on ${chain}: ${message}`,
    );
  }

  const name = assertCuratedName(metadata.name);
  const symbol = assertCuratedSymbol(metadata.symbol);
  if (!Number.isInteger(metadata.decimals) || metadata.decimals < 0 || metadata.decimals > 255) {
    throw new TokenMetadataError(`decimals() returned ${String(metadata.decimals)}`);
  }

  assertNewSymbol(chain, symbol, symbolsOnChain(root, chain));

  console.info(`✅ Name: ${name}`);
  console.info(`✅ Symbol: ${symbol}`);
  console.info(`✅ Decimals: ${metadata.decimals}`);

  const logo = await fetchTokenLogo({
    chainId,
    address,
    fetchImpl: input.fetchImpl,
    convertLogo: input.convertLogo,
  });

  const logoHash = sha256Hex(logo.bytes);
  const logoURL = `tokens/${chain}/${address}/logo.webp`;
  const token = sortEvmToken({
    name,
    symbol,
    decimals: metadata.decimals,
    address,
    coingeckoId: logo.coingeckoId,
    logoURL,
    logoHash,
  });

  const logoSource = logo.source === "coingecko" ? "CoinGecko" : "Trust Wallet";
  console.info(`✅ CoinGecko: ${token.coingeckoId ?? "(none)"}`);
  console.info(`✅ Logo: ${logoSource}`);

  fs.mkdirSync(outputDir, { recursive: true });
  const logoPath = path.join(outputDir, "logo.webp");
  const infoPath = path.join(outputDir, "info.json");
  const allPath = path.join(root, "data", "tokens", chain, "all.json");
  try {
    fs.writeFileSync(logoPath, logo.bytes);
    writeFormattedJson(infoPath, token);
    const aggregate = insertEvmToken(readAggregate(allPath), token);
    writeFormattedJson(allPath, aggregate);
  } catch (error) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw error;
  }

  console.info(`\n📁 Token information saved to: ${path.relative(root, infoPath)}`);
  console.info(`📁 Token logo saved to: ${path.relative(root, logoPath)}`);
  console.info(`📁 Updated data/tokens/${chain}/all.json`);
  console.info("\n✅ Token added successfully!");
  return token;
}

export async function runAddTokenCli(
  argv: string[],
  overrides: Omit<AddTokenInput, "chain" | "address"> = {},
): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.info(ADD_TOKEN_USAGE);
    return;
  }
  if (argv.length !== 2) {
    console.error(ADD_TOKEN_USAGE);
    process.exitCode = 1;
    return;
  }
  const chain = argv[0] ?? "";
  const address = argv[1] ?? "";
  try {
    await addToken({ chain, address, ...overrides });
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  runAddTokenCli(process.argv.slice(2)).catch((error) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export default addToken;
