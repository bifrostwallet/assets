import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createPublicClient, type Hex, http, type PublicClient } from "viem";
import { ASSET_LOGO_REQUIREMENTS } from "../config.js";
import { isMain } from "../isMain.js";
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
 * Advisory token catalog audit:
 * 1. Schema / coingeckoId field presence
 * 2. Logo file + published size rules (outliers reported, not fatal)
 * 3. On-chain name / symbol / decimals vs curated (when RPC env is set)
 *
 * Never mutates data. Exit 0 even with mismatches (CI warnings).
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
  }

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
  console.info(`Metadata mismatches: ${report.mismatches.length}`);
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
