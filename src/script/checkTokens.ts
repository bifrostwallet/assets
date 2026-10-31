import * as fs from "node:fs";
import * as path from "node:path";
import { createPublicClient, type Hex, hexToString, http, type PublicClient } from "viem";
import { ASSET_LOGO_REQUIREMENTS } from "../config.js";
import { isMain } from "../isMain.js";
import {
  assertTokenCoingeckoIdField,
  listTokenChainPaths,
  listTokenDirs,
  loadBlocklist,
  loadTokenInfo,
  type TokenInfo,
} from "../tokens.js";
import { isValidImage } from "../validate.js";

/**
 * Token catalog audit:
 * 1. Schema / coingeckoId field presence
 * 2. Logo file + published size rules (outliers reported, not fatal)
 * 3. On-chain name / symbol / decimals vs curated (when RPC env is set)
 *
 * Never mutates data. Symbol mismatches outside the exception list, and symbol
 * reads that still fail after retries, exit non-zero. Name and decimals
 * mismatches stay advisory.
 *
 * RPC env (optional, per chain):
 *   ETHEREUM_NODE_URL, OPTIMISM_NODE_URL, FLARE_NODE_URL, SONGBIRD_NODE_URL,
 *   XDC_NODE_URL, BNBSMARTCHAIN_NODE_URL, POLYGON_NODE_URL, FANTOM_NODE_URL,
 *   BASE_NODE_URL, ARBITRUM_NODE_URL, HYPERLIQUID_NODE_URL
 */

const ERC20_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
] as const;

const ERC20_BYTES32_SYMBOL_ABI = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

/**
 * Curated symbols that intentionally differ from on-chain symbol().
 * One reason each. Do not add entries for symbols that fail format checks.
 */
const SYMBOL_EXCEPTIONS: readonly {
  chainId: number;
  address: string;
  symbol: string;
  reason: string;
}[] = [
  {
    chainId: 1,
    address: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
    symbol: "SAI",
    reason: "On-chain bytes32 is DAI; curated symbol stays SAI so it is not confused with DAI.",
  },
  {
    chainId: 1,
    address: "0x88acdd2a6425c3faae4bc9650fd7e27e0bebb7ab",
    symbol: "MIST",
    reason: "On-chain symbol is an emoji, which the symbol format does not allow.",
  },
];

const RPC_ENV_BY_CHAIN: Record<number, string> = {
  1: "ETHEREUM_NODE_URL",
  10: "OPTIMISM_NODE_URL",
  14: "FLARE_NODE_URL",
  19: "SONGBIRD_NODE_URL",
  50: "XDC_NODE_URL",
  56: "BNBSMARTCHAIN_NODE_URL",
  137: "POLYGON_NODE_URL",
  250: "FANTOM_NODE_URL",
  8453: "BASE_NODE_URL",
  42161: "ARBITRUM_NODE_URL",
  999: "HYPERLIQUID_NODE_URL",
};

type Mismatch = {
  chainPath: string;
  address: string;
  field: "name" | "symbol" | "decimals";
  curated: string | number;
  onchain: string | number;
};

type CheckReport = {
  checked: number;
  schemaErrors: string[];
  missingLogos: string[];
  logoOutliers: { path: string; errors: string[] }[];
  onchainSkippedChains: string[];
  onchainChecked: number;
  onchainRpcErrors: string[];
  /** symbol() reads that failed after retries. These fail the process. */
  symbolReadErrors: string[];
  mismatches: Mismatch[];
};

function chainIdFromPath(chainPath: string): number | null {
  const m = /^eip155-(\d+)$/.exec(chainPath);
  return m ? Number(m[1]) : null;
}

function rpcUrlForChain(chainId: number): string | undefined {
  const primary = RPC_ENV_BY_CHAIN[chainId];
  if (!primary) return undefined;
  return process.env[primary];
}

function clientFor(chainId: number, rpc: string): PublicClient {
  return createPublicClient({
    chain: {
      id: chainId,
      name: `eip155-${chainId}`,
      nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    },
    transport: http(rpc, { timeout: 20000, retryCount: 4, retryDelay: 500 }),
  });
}

/** Strip trailing NUL padding from a bytes32 symbol and decode UTF-8. */
function decodeBytes32Symbol(value: Hex): string {
  const body = value
    .toLowerCase()
    .replace(/^0x/, "")
    .replace(/(00)+$/, "");
  if (body.length === 0) return "";
  return hexToString(`0x${body}`);
}

/**
 * Drop NUL padding. A value that is only NULs or whitespace is an incomplete
 * RPC response, not a symbol, so the caller can retry it.
 */
function normalizeSymbol(symbol: string): string {
  const stripped = symbol.replaceAll("\u0000", "").trim();
  if (stripped.length === 0) {
    throw new Error("symbol() returned an empty value");
  }
  return stripped;
}

function isEmptySymbolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("returned an empty value");
}

function isSymbolException(chainId: number, address: string, symbol: string): boolean {
  return SYMBOL_EXCEPTIONS.some(
    (entry) => entry.chainId === chainId && entry.address === address && entry.symbol === symbol,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reverts are deterministic. Timeouts and rate limits are not. */
function isRetryableRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !/revert|returned no data|out of gas/i.test(message);
}

async function withRpcRetry<T>(fn: () => Promise<T>): Promise<T> {
  const attempts = 4;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (attempt === attempts || !isRetryableRpcError(error)) throw error;
      await sleep(400 * attempt);
    }
  }
  throw last;
}

/**
 * symbol() is string on most tokens and bytes32 on a few (MKR, AVT, DF).
 * A failed string decode is retried as bytes32 and decoded to text.
 */
async function readSymbol(client: PublicClient, address: Hex): Promise<string> {
  try {
    const symbol = await client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" });
    return normalizeSymbol(symbol);
  } catch (stringError) {
    if (isEmptySymbolError(stringError)) throw stringError;
    try {
      const raw = await client.readContract({
        address,
        abi: ERC20_BYTES32_SYMBOL_ABI,
        functionName: "symbol",
      });
      return normalizeSymbol(decodeBytes32Symbol(raw));
    } catch {
      throw stringError;
    }
  }
}

function checkSchemaAndLogo(
  chainPath: string,
  info: TokenInfo,
  dir: string,
  report: CheckReport,
): void {
  const label = `${chainPath}/${tokenDirLabel(info)}`;
  try {
    assertTokenCoingeckoIdField(info, label);
  } catch (error) {
    report.schemaErrors.push(error instanceof Error ? error.message : String(error));
  }

  if (typeof info.name !== "string" || !info.name.trim()) {
    report.schemaErrors.push(`${label}: invalid name`);
  }
  if (typeof info.symbol !== "string" || !info.symbol.trim()) {
    report.schemaErrors.push(`${label}: invalid symbol`);
  }
  if (typeof info.decimals !== "number" || !Number.isInteger(info.decimals) || info.decimals < 0) {
    report.schemaErrors.push(`${label}: invalid decimals`);
  }
  if (info.address === null) {
    // Native gas token — no contract address
  } else if (typeof info.address !== "string" || !/^0x[0-9a-f]{40}$/.test(info.address)) {
    report.schemaErrors.push(`${label}: address must be lowercase 0x…40 or null (native)`);
  }

  const logoPath = path.join(dir, "logo.webp");
  if (!fs.existsSync(logoPath)) {
    report.missingLogos.push(label);
    return;
  }
  const check = isValidImage(logoPath, {
    maxSizeKB: ASSET_LOGO_REQUIREMENTS.MAX_SIZE_KB,
    minWidth: ASSET_LOGO_REQUIREMENTS.MIN_WIDTH,
    maxWidth: ASSET_LOGO_REQUIREMENTS.MAX_WIDTH,
    requireSquare: ASSET_LOGO_REQUIREMENTS.REQUIRE_SQUARE,
  });
  if (!check.isValid) {
    report.logoOutliers.push({ path: info.logoURL, errors: check.errors });
  }
}

function tokenDirLabel(info: TokenInfo): string {
  return info.address === null ? "native" : info.address;
}

async function mapPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await fn(items[current]);
    }
  });
  await Promise.all(workers);
}

async function checkTokens(): Promise<void> {
  const report: CheckReport = {
    checked: 0,
    schemaErrors: [],
    missingLogos: [],
    logoOutliers: [],
    onchainSkippedChains: [],
    onchainChecked: 0,
    onchainRpcErrors: [],
    symbolReadErrors: [],
    mismatches: [],
  };

  const clients = new Map<number, PublicClient>();
  const skipOnchain = process.argv.includes("--skip-onchain");
  const onchainJobs: {
    chainPath: string;
    chainId: number;
    info: TokenInfo;
    address: string;
    client: PublicClient;
  }[] = [];

  for (const chainPath of listTokenChainPaths()) {
    const chainId = chainIdFromPath(chainPath);
    const rpc = chainId !== null ? rpcUrlForChain(chainId) : undefined;
    if (!skipOnchain && chainId !== null && rpc) {
      clients.set(chainId, clientFor(chainId, rpc));
    } else if (!skipOnchain && chainId !== null) {
      report.onchainSkippedChains.push(chainPath);
    }

    for (const { dir } of listTokenDirs(chainPath)) {
      const info = loadTokenInfo(path.join(dir, "info.json"));
      report.checked += 1;
      checkSchemaAndLogo(chainPath, info, dir, report);

      if (skipOnchain || info.address === null || !info.address || chainId === null) continue;
      const client = clients.get(chainId);
      if (!client) continue;
      onchainJobs.push({ chainPath, chainId, info, address: info.address, client });
    }
  }

  await mapPool(onchainJobs, 4, async ({ chainPath, chainId, info, address, client }) => {
    const contract = address as Hex;
    try {
      const symbol = await withRpcRetry(() => readSymbol(client, contract));
      report.onchainChecked += 1;
      if (symbol !== info.symbol && !isSymbolException(chainId, address, info.symbol)) {
        report.mismatches.push({
          chainPath,
          address,
          field: "symbol",
          curated: info.symbol,
          onchain: symbol,
        });
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      // A revert or empty return is the contract, not a flaky RPC. Transport
      // failures stay fatal so a dead endpoint cannot pass the symbol check.
      if (isRetryableRpcError(error)) {
        report.symbolReadErrors.push(`${chainPath}/${address}: ${message}`);
      } else {
        report.onchainRpcErrors.push(`${chainPath}/${address}: ${message}`);
      }
    }

    try {
      const [name, decimals] = await Promise.all([
        client.readContract({ address: contract, abi: ERC20_ABI, functionName: "name" }),
        client.readContract({ address: contract, abi: ERC20_ABI, functionName: "decimals" }),
      ]);
      if (name !== info.name) {
        report.mismatches.push({
          chainPath,
          address,
          field: "name",
          curated: info.name,
          onchain: name,
        });
      }
      if (Number(decimals) !== info.decimals) {
        report.mismatches.push({
          chainPath,
          address,
          field: "decimals",
          curated: info.decimals,
          onchain: Number(decimals),
        });
      }
    } catch (error) {
      report.onchainRpcErrors.push(
        `${chainPath}/${address}: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`,
      );
    }
  });

  // Touch blocklist so missing file surfaces early
  loadBlocklist();

  const reportsDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, "tokens-check.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.info(`\n=== Token catalog check (${report.checked} entries) ===`);
  console.info(`Schema errors: ${report.schemaErrors.length}`);
  console.info(`Missing logos: ${report.missingLogos.length}`);
  console.info(`Logo outliers: ${report.logoOutliers.length}`);
  console.info(`On-chain checked: ${report.onchainChecked}`);
  console.info(
    `On-chain skipped chains (no RPC): ${report.onchainSkippedChains.join(", ") || "(none)"}`,
  );
  console.info(`On-chain RPC errors: ${report.onchainRpcErrors.length}`);
  console.info(`Symbol read errors: ${report.symbolReadErrors.length}`);
  console.info(`Metadata mismatches: ${report.mismatches.length}`);
  const symbolMismatches = report.mismatches.filter((row) => row.field === "symbol");
  if (report.mismatches.length > 0) {
    console.info("\nSample mismatches (first 20):");
    for (const row of report.mismatches.slice(0, 20)) {
      console.info(
        `  ${row.chainPath} ${row.address} ${row.field}: curated=${JSON.stringify(row.curated)} onchain=${JSON.stringify(row.onchain)}`,
      );
    }
  }
  if (symbolMismatches.length > 0) {
    console.error("\nSymbol mismatches:");
    for (const row of symbolMismatches) {
      console.error(
        `  ${row.chainPath} ${row.address}: curated=${JSON.stringify(row.curated)} onchain=${JSON.stringify(row.onchain)}`,
      );
    }
  }
  if (report.symbolReadErrors.length > 0) {
    console.error("\nSymbol reads failed after retries:");
    for (const line of report.symbolReadErrors) {
      console.error(`  ${line}`);
    }
  }
  console.info(`\nReport: ${reportPath}`);

  if (symbolMismatches.length > 0 || report.symbolReadErrors.length > 0) {
    console.error(
      `❌ Symbol check failed (${symbolMismatches.length} mismatches, ${report.symbolReadErrors.length} read errors)`,
    );
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  checkTokens().catch((error) => {
    console.error("❌ Token check failed:", error);
    process.exitCode = 1;
  });
}

export default checkTokens;
