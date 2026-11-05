import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createPublicClient, type Hex, http, type PublicClient } from "viem";
import { ASSET_LOGO_REQUIREMENTS } from "../config.js";
import { chainIdFromPath, rpcUrlForChain } from "../evmRpc.js";
import { isMain } from "../isMain.js";
import { duplicateSymbolErrors, listEvmSymbolUses } from "../tokenSymbols.js";
import {
  type EvmToken,
  listTokenChainPaths,
  listTokenDirs,
  loadBlocklist,
  loadEvmToken,
  validateEvmToken,
} from "../tokens.js";
import { isValidImage } from "../validate.js";
import {
  listXrplTokenDirs,
  validateXrplToken,
  XRPL_MAINNET_CHAIN_PATH,
  type XrplToken,
  xrplCatalogPathErrors,
} from "../xrplToken.js";

/**
 * Token catalog audit:
 * 1. Schema / coingeckoId field presence
 * 2. Logo file + published size rules (outliers reported, not fatal)
 * 3. On-chain name / symbol / decimals vs curated (when RPC env is set)
 *
 * Never mutates data. Symbol mismatches outside the exception list, symbol
 * reads that still fail after retries, and a symbol() that is not an ABI
 * string exit non-zero. Name and decimals mismatches stay advisory.
 * symbol() is read as a string only. bytes32 symbols are not supported.
 * This pass reads chain state only when a `*_NODE_URL` is already set; CI
 * does not set them. A new duplicate EVM symbol exits 1. Duplicate symbols
 * already on main are grandfathered in `tokenSymbols.ts`. A `.` in a symbol
 * is kept, because that character is part of the on-chain text.
 *
 * RPC env (optional, per chain; see `RPC_ENV_BY_CHAIN`):
 *   ETHEREUM_NODE_URL, OPTIMISM_NODE_URL, FLARE_NODE_URL, SONGBIRD_NODE_URL,
 *   XDC_NODE_URL, BNBSMARTCHAIN_NODE_URL, POLYGON_NODE_URL, BASE_NODE_URL,
 *   ARBITRUM_NODE_URL, HYPERLIQUID_NODE_URL
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

/**
 * Curated symbols that intentionally differ from on-chain string symbol().
 * One reason each. Do not add entries for symbols that fail format checks.
 * bytes32 symbol() is not supported and is not an exception.
 */
const SYMBOL_EXCEPTIONS: readonly {
  chainId: number;
  address: string;
  symbol: string;
  reason: string;
}[] = [
  {
    chainId: 1,
    address: "0x88acdd2a6425c3faae4bc9650fd7e27e0bebb7ab",
    symbol: "MIST",
    reason: "On-chain symbol is an emoji, which the symbol format does not allow.",
  },
];

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
  /** symbol() reads that failed. These fail the process. */
  symbolReadErrors: string[];
  mismatches: Mismatch[];
  duplicateSymbols: string[];
};

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

const UNSUPPORTED_SYMBOL = "symbol() is not an ABI string (bytes32 symbols are not supported)";

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { name?: unknown; message?: unknown; cause?: unknown };
    if (typeof record.name === "string") parts.push(record.name);
    if (typeof record.message === "string") parts.push(record.message);
    current = record.cause;
  }
  return parts.length > 0 ? parts.join("\n") : String(error);
}

/** ABI decode failed because symbol() did not return a string. */
function isNonStringSymbolDecode(error: unknown): boolean {
  const text = errorChainText(error);
  if (/revert|returned no data|out of gas/i.test(text)) return false;
  return /DataSizeTooSmall|PositionOutOfBounds|SliceOffsetOutOfBounds|too small for given parameters|out of bounds|out-of-bounds/i.test(
    text,
  );
}

function isUnsupportedSymbolError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(UNSUPPORTED_SYMBOL);
}

function isSymbolException(chainId: number, address: string, symbol: string): boolean {
  return SYMBOL_EXCEPTIONS.some(
    (entry) => entry.chainId === chainId && entry.address === address && entry.symbol === symbol,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reverts and a non-string symbol() are deterministic. Timeouts, rate limits, and an empty symbol are not. */
function isRetryableRpcError(error: unknown): boolean {
  if (isUnsupportedSymbolError(error)) return false;
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
 * symbol() is an ABI string. A bytes32 return cannot be decoded as a string
 * and is not supported.
 */
async function readSymbol(client: PublicClient, address: Hex): Promise<string> {
  let symbol: unknown;
  try {
    symbol = await client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" });
  } catch (error) {
    if (isNonStringSymbolDecode(error)) {
      throw new Error(UNSUPPORTED_SYMBOL);
    }
    throw error;
  }
  if (typeof symbol !== "string") {
    throw new Error(UNSUPPORTED_SYMBOL);
  }
  return normalizeSymbol(symbol);
}

function checkLogoFile(label: string, dir: string, logoURL: string, report: CheckReport): void {
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
    report.logoOutliers.push({ path: logoURL, errors: check.errors });
  }
}

function checkEvmSchemaAndLogo(
  chainPath: string,
  info: EvmToken,
  dir: string,
  report: CheckReport,
): void {
  const label = `${chainPath}/${info.address === null ? "native" : info.address}`;
  for (const error of validateEvmToken(info)) {
    report.schemaErrors.push(`${label}: ${error}`);
  }
  checkLogoFile(label, dir, info.logoURL, report);
}

function checkXrplChain(report: CheckReport): void {
  const chainPath = XRPL_MAINNET_CHAIN_PATH;
  for (const error of xrplCatalogPathErrors()) {
    report.schemaErrors.push(error);
  }
  const entries: XrplToken[] = [];
  for (const { issuerDir, currencyDir, dir } of listXrplTokenDirs()) {
    const label = `${chainPath}/${issuerDir}/${currencyDir}`;
    const infoPath = path.join(dir, "info.json");
    let info: unknown;
    try {
      info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    } catch (error) {
      report.schemaErrors.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      report.checked += 1;
      continue;
    }
    report.checked += 1;
    const logoFile = path.join(dir, "logo.webp");
    const logoSha256 = fs.existsSync(logoFile)
      ? createHash("sha256").update(fs.readFileSync(logoFile)).digest("hex")
      : undefined;
    for (const error of validateXrplToken(info, issuerDir, currencyDir, logoSha256)) {
      report.schemaErrors.push(`${label}: ${error}`);
    }
    if (info && typeof info === "object" && !Array.isArray(info)) {
      entries.push(info as XrplToken);
    }
    const logoURL =
      info && typeof info === "object" && !Array.isArray(info) && "logoURL" in info
        ? String((info as { logoURL?: unknown }).logoURL ?? "")
        : "";
    checkLogoFile(label, dir, logoURL, report);
  }
  checkXrplAggregate(chainPath, entries, report);
}

/** `all.json` is what the package publishes, so it has to match every info.json. */
function checkXrplAggregate(chainPath: string, entries: XrplToken[], report: CheckReport): void {
  const allPath = path.join(process.cwd(), "data", "tokens", chainPath, "all.json");
  if (!fs.existsSync(allPath)) {
    report.schemaErrors.push(`${chainPath}/all.json: missing aggregate`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(allPath, "utf8"));
  } catch (error) {
    report.schemaErrors.push(
      `${chainPath}/all.json: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!Array.isArray(parsed)) {
    report.schemaErrors.push(`${chainPath}/all.json: expected an array`);
    return;
  }
  const sorted = [...entries].sort(
    (a, b) =>
      String(a.issuer).localeCompare(String(b.issuer)) ||
      String(a.currency).localeCompare(String(b.currency)),
  );
  if (JSON.stringify(parsed) !== JSON.stringify(sorted)) {
    report.schemaErrors.push(
      `${chainPath}/all.json: does not match info.json entries in issuer and currency order`,
    );
  }
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
    duplicateSymbols: [],
  };

  const clients = new Map<number, PublicClient>();
  const skipOnchain = process.argv.includes("--skip-onchain");
  const onchainJobs: {
    chainPath: string;
    chainId: number;
    info: EvmToken;
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

    if (chainPath === XRPL_MAINNET_CHAIN_PATH) {
      checkXrplChain(report);
      continue;
    }

    for (const { dir } of listTokenDirs(chainPath)) {
      const info = loadEvmToken(path.join(dir, "info.json"));
      report.checked += 1;
      checkEvmSchemaAndLogo(chainPath, info, dir, report);

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
      // A revert or empty return is the contract, not a flaky RPC. A non-string
      // symbol() is not supported and fails the run. Transport failures stay
      // fatal so a dead endpoint cannot pass the symbol check.
      if (isUnsupportedSymbolError(error) || isRetryableRpcError(error)) {
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
  report.duplicateSymbols = duplicateSymbolErrors(listEvmSymbolUses());

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
  console.info(`Duplicate symbol violations: ${report.duplicateSymbols.length}`);
  const symbolFailures = report.duplicateSymbols;
  if (symbolFailures.length > 0) {
    console.error("\nToken symbol rules failed:");
    for (const line of symbolFailures) {
      console.error(`  ${line}`);
    }
    process.exitCode = 1;
  }
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
    console.error("\nSymbol reads failed:");
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
