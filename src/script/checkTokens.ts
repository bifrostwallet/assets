import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createPublicClient, type Hex, http, type PublicClient } from "viem";
import { ASSET_LOGO_REQUIREMENTS } from "../config.js";
import { buildTokensAllJson } from "../convert.js";
import { chainIdFromPath, rpcUrlForChain } from "../evmRpc.js";
import { isMain } from "../isMain.js";
import { duplicateSymbolErrors, listEvmSymbolUses } from "../tokenSymbols.js";
import {
  type EvmToken,
  listTokenChainPaths,
  listTokenDirs,
  loadEvmToken,
  validateEvmToken,
} from "../tokens.js";
import { isValidImage } from "../validate.js";
import {
  listXrplTokenDirs,
  validateXrplToken,
  XRPL_MAINNET_CHAIN_PATH,
  xrplCatalogPathErrors,
} from "../xrplToken.js";

/**
 * Advisory token catalog audit:
 * 1. Schema / coingeckoId field presence
 * 2. Logo file + published size rules (outliers reported, not fatal)
 * 3. On-chain name / symbol / decimals vs curated (when RPC env is set)
 *
 * Never mutates data. On-chain mismatches are warnings (exit 0). This pass
 * reads chain state only when a `*_NODE_URL` is already set; CI does not set
 * them. A new duplicate EVM symbol, a symbol containing `.`, or a token
 * `all.json` that does not match `rebuildTokensAllJson`, exits 1.
 * Duplicate symbols already on main are grandfathered in `tokenSymbols.ts`.
 *
 * RPC env (optional, per chain; see `RPC_ENV_BY_CHAIN`):
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
  mismatches: Mismatch[];
  symbolDotErrors: string[];
  duplicateSymbols: string[];
  aggregateErrors: string[];
};

function clientFor(chainId: number, rpc: string): PublicClient {
  return createPublicClient({
    chain: {
      id: chainId,
      name: `eip155-${chainId}`,
      nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    },
    transport: http(rpc, { timeout: 20000, retryCount: 2 }),
  });
}

async function readErc20Meta(
  client: PublicClient,
  address: Hex,
): Promise<{ name: string; symbol: string; decimals: number }> {
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: ERC20_ABI, functionName: "name" }),
    client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }),
    client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }),
  ]);
  return { name, symbol, decimals: Number(decimals) };
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
    if (error === 'symbol contains "."' && typeof info.symbol === "string") {
      report.symbolDotErrors.push(
        `${label}: symbol ${JSON.stringify(info.symbol)} contains "."; symbols with a dot are not supported`,
      );
    }
  }
  checkLogoFile(label, dir, info.logoURL, report);
}

function checkXrplChain(report: CheckReport): void {
  const chainPath = XRPL_MAINNET_CHAIN_PATH;
  for (const error of xrplCatalogPathErrors()) {
    report.schemaErrors.push(error);
  }
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
    const logoURL =
      info && typeof info === "object" && !Array.isArray(info) && "logoURL" in info
        ? String((info as { logoURL?: unknown }).logoURL ?? "")
        : "";
    checkLogoFile(label, dir, logoURL, report);
  }
}

/**
 * EVM and XRPL `all.json` must equal {@link buildTokensAllJson}.
 * `info.json` stays relative; the aggregate uses absolute GitHub logo URLs.
 */
function checkTokenAggregate(chainPath: string, report: CheckReport): void {
  const allPath = path.join(process.cwd(), "data", "tokens", chainPath, "all.json");
  if (!fs.existsSync(allPath)) {
    report.aggregateErrors.push(`${chainPath}/all.json: missing aggregate`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(allPath, "utf8"));
  } catch (error) {
    report.aggregateErrors.push(
      `${chainPath}/all.json: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!Array.isArray(parsed)) {
    report.aggregateErrors.push(`${chainPath}/all.json: expected an array`);
    return;
  }
  let expected: unknown;
  try {
    expected = buildTokensAllJson(chainPath);
  } catch (error) {
    report.aggregateErrors.push(
      `${chainPath}/all.json: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    report.aggregateErrors.push(
      `${chainPath}/all.json: does not match rebuildTokensAllJson output`,
    );
  }
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
    mismatches: [],
    symbolDotErrors: [],
    duplicateSymbols: [],
    aggregateErrors: [],
  };

  const clients = new Map<number, PublicClient>();
  const skipOnchain = process.argv.includes("--skip-onchain");

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
      checkTokenAggregate(chainPath, report);
      continue;
    }

    for (const { dir } of listTokenDirs(chainPath)) {
      const info = loadEvmToken(path.join(dir, "info.json"));
      report.checked += 1;
      checkEvmSchemaAndLogo(chainPath, info, dir, report);

      if (skipOnchain || info.address === null || !info.address || chainId === null) continue;
      const client = clients.get(chainId);
      if (!client) continue;

      try {
        const onchain = await readErc20Meta(client, info.address as Hex);
        report.onchainChecked += 1;
        if (onchain.name !== info.name) {
          report.mismatches.push({
            chainPath,
            address: info.address,
            field: "name",
            curated: info.name,
            onchain: onchain.name,
          });
        }
        if (onchain.symbol !== info.symbol) {
          report.mismatches.push({
            chainPath,
            address: info.address,
            field: "symbol",
            curated: info.symbol,
            onchain: onchain.symbol,
          });
        }
        if (onchain.decimals !== info.decimals) {
          report.mismatches.push({
            chainPath,
            address: info.address,
            field: "decimals",
            curated: info.decimals,
            onchain: onchain.decimals,
          });
        }
      } catch (error) {
        report.onchainRpcErrors.push(
          `${chainPath}/${info.address}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    checkTokenAggregate(chainPath, report);
  }

  report.duplicateSymbols = duplicateSymbolErrors(listEvmSymbolUses());

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
  console.info(`Metadata mismatches: ${report.mismatches.length}`);
  console.info(`Symbol dot violations: ${report.symbolDotErrors.length}`);
  console.info(`Duplicate symbol violations: ${report.duplicateSymbols.length}`);
  console.info(`Aggregate mismatches: ${report.aggregateErrors.length}`);
  const symbolFailures = [...report.symbolDotErrors, ...report.duplicateSymbols];
  if (symbolFailures.length > 0) {
    console.error("\nToken symbol rules failed:");
    for (const line of symbolFailures) {
      console.error(`  ${line}`);
    }
    process.exitCode = 1;
  }
  if (report.aggregateErrors.length > 0) {
    console.error("\nToken all.json does not match the rebuild helper:");
    for (const line of report.aggregateErrors) {
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
  console.info(`\nReport: ${reportPath}`);
}

if (isMain(import.meta.url)) {
  checkTokens().catch((error) => {
    console.error("❌ Token check failed:", error);
    process.exitCode = 1;
  });
}

export default checkTokens;
