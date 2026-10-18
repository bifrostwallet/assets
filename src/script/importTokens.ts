import * as fs from "node:fs";
import * as path from "node:path";
import { ASSET_LOGO_REQUIREMENTS } from "../config.js";
import { isMain } from "../isMain.js";
import { sha256Hex } from "../manifest.js";
import {
  caip2Path,
  rebuildAllTokensAllJson,
  sortTokenInfo,
  type TokenBlocklistEntry,
  type TokenInfo,
  tokenDirName,
  tokenLogoRelativePath,
} from "../tokens.js";
import { isValidImage } from "../validate.js";
import { encodePngFileToWebp, readWebpDimensions } from "../webp.js";

/**
 * One-shot lift from sibling `@towolabs/tokens` (tokenlist / nativelist / blocklist + PNGs).
 *
 * - Migrates every listed entry (including testnets); does not grow the set from CoinGecko.
 * - Always writes `coingeckoId: string | null` (required field).
 * - CoinGecko is used only to resolve ids (platforms join + hydration custom overrides).
 * - Logos → 128×128 WebP; size/dimension outliers are flagged, not blocking.
 *
 * Usage:
 *   ./yarn import:tokens
 *   ./yarn import:tokens -- --tokens-repo=/path/to/tokens
 *   ./yarn import:tokens -- --skip-coingecko
 */

type SourceErc20 = {
  chainId: number;
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI: string;
};

type SourceNative = {
  chainId: number;
  name: string;
  symbol: string;
  decimals: number;
  logoURI: string;
};

type SourceBlock = {
  chainID: number;
  address: string;
  identifier: string;
};

type CgCoin = {
  id: string;
  platforms?: Record<string, string | undefined>;
};

/** CoinGecko `platforms` keys for livenet EVM chains we care about. */
const CG_PLATFORM_BY_CHAIN: Record<number, string> = {
  1: "ethereum",
  10: "optimistic-ethereum",
  14: "flare-network",
  19: "songbird",
  50: "xdc-network",
  56: "binance-smart-chain",
  137: "polygon-pos",
  250: "fantom",
  8453: "base",
  42161: "arbitrum-one",
  999: "hyperliquid",
};

/** Bifrost chain slugs used by data-hydration `customTokens`. */
const CHAIN_SLUG_TO_ID: Record<string, number> = {
  "eth-livenet": 1,
  "opti-livenet": 10,
  "flr-livenet": 14,
  "flr-coston": 16,
  "sgb-livenet": 19,
  "xdc-livenet": 50,
  "bnb-livenet": 56,
  "flr-coston2": 114,
  "matic-livenet": 137,
  "ftm-livenet": 250,
  "hype-livenet": 999,
  "base-livenet": 8453,
  "arb-livenet": 42161,
  "eth-sepolia": 11155111,
};

/**
 * Hydration custom overrides (address/native → coingeckoId).
 * Copied so import does not depend on that repo at runtime.
 */
const CUSTOM_COINGECKO: { coingeckoId: string; address: string; chain: string }[] = [
  {
    coingeckoId: "flare-finance",
    address: "0xc348f894d0e939fe72c467156e6d7dcbd6f16e21",
    chain: "sgb-livenet",
  },
  {
    coingeckoId: "canary-dollar",
    address: "0x70ad7172ef0b131a1428d0c1f66457eb041f2176",
    chain: "sgb-livenet",
  },
  {
    coingeckoId: "flare-networks",
    address: "native",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "flare-networks",
    address: "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "usd-coin",
    address: "0xFbDa5F676cB37624f28265A144A48B0d6e87d3b6",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "tether",
    address: "0x0B38e83B86d491735fEaa0a791F65c2B99535396",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "tether",
    address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "ethereum",
    address: "0x1502FA4be69d526124D453619276FacCab275d3D",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "enosys-usdt",
    address: "0x96B41289D90444B8adD57e6F265DB5aE8651DF29",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "ethereum",
    address: "0xa76DCDdcE60a442d69Bac7158F3660f50921b122",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "flare-bridged-xrp-flare",
    address: "0xAd552A648C74D49E10027AB8a618A3ad4901c5bE",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "firelight-staked-xrp",
    address: "0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "enosys-loans-cdp",
    address: "0x6Cd3a5Ba46FA254D4d2E3C2B37350ae337E94a0F",
    chain: "flr-livenet",
  },
  {
    coingeckoId: "songbird",
    address: "native",
    chain: "sgb-livenet",
  },
  {
    coingeckoId: "songbird",
    address: "0x02f0826ef6aD107Cfc861152B32B52fD11BaB9ED",
    chain: "sgb-livenet",
  },
  {
    coingeckoId: "enosys-usdt",
    address: "0x1a7b46656B2b8b29B1694229e122d066020503D0",
    chain: "sgb-livenet",
  },
  {
    coingeckoId: "ethereum",
    address: "0x36B84a93820175c02F57E5c87a7Ea33Df58E5c94",
    chain: "sgb-livenet",
  },
  {
    coingeckoId: "xdce-crowd-sale",
    address: "0xC54De96302981f87a6F80E4607593681B44d670c",
    chain: "sgb-livenet",
  },
  {
    coingeckoId: "ripple",
    address: "0xF9a84f4ec903F4EaB117A9c1098BeC078BA7027d",
    chain: "sgb-livenet",
  },
  {
    coingeckoId: "dogecoin",
    address: "0xaa25ee3B68c515e69A463876Ab262bc4e8339030",
    chain: "sgb-livenet",
  },
  {
    coingeckoId: "bitcoin",
    address: "0xbA17AF59dCf544AaFE69F622eB93bFc0Ed1B1a6a",
    chain: "sgb-livenet",
  },
  { coingeckoId: "ethereum", address: "native", chain: "eth-livenet" },
  { coingeckoId: "binancecoin", address: "native", chain: "bnb-livenet" },
  {
    coingeckoId: "polygon-ecosystem-token",
    address: "native",
    chain: "matic-livenet",
  },
  { coingeckoId: "fantom", address: "native", chain: "ftm-livenet" },
  { coingeckoId: "ethereum", address: "native", chain: "arb-livenet" },
  { coingeckoId: "ethereum", address: "native", chain: "opti-livenet" },
  { coingeckoId: "ethereum", address: "native", chain: "base-livenet" },
  { coingeckoId: "xdce-crowd-sale", address: "native", chain: "xdc-livenet" },
  {
    coingeckoId: "xdce-crowd-sale",
    address: "0x951857744785E80e2De051c32EE7b25f9c458C42",
    chain: "xdc-livenet",
  },
  {
    coingeckoId: "usd-coin",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    chain: "base-livenet",
  },
  {
    coingeckoId: "euro-coin",
    address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    chain: "base-livenet",
  },
  { coingeckoId: "hyperliquid", address: "native", chain: "hype-livenet" },
];

type ImportReport = {
  tokensRepo: string;
  imported: number;
  natives: number;
  erc20: number;
  blocklist: number;
  coingeckoResolved: number;
  coingeckoNull: number;
  missingLogos: string[];
  encodeFailures: string[];
  logoOutliers: { path: string; reason: string }[];
  byChain: Record<string, number>;
};

function argValue(flag: string): string | undefined {
  const prefix = `${flag}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("-")) {
    return process.argv[idx + 1];
  }
  return undefined;
}

function resolveTokensRepo(): string {
  const fromArg = argValue("--tokens-repo");
  if (fromArg) return path.resolve(fromArg);
  const sibling = path.resolve(process.cwd(), "..", "tokens");
  if (fs.existsSync(path.join(sibling, "bifrost-wallet.tokenlist.json"))) return sibling;
  throw new Error(
    "tokens repo not found — pass --tokens-repo=/path/to/tokens (expected sibling ../tokens)",
  );
}

function buildCustomIdMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of CUSTOM_COINGECKO) {
    const chainId = CHAIN_SLUG_TO_ID[row.chain];
    if (chainId === undefined) continue;
    const addr = row.address === "native" ? "native" : row.address.toLowerCase();
    map.set(`${chainId}:${addr}`, row.coingeckoId);
  }
  return map;
}

async function fetchCoingeckoPlatformIndex(): Promise<Map<string, string>> {
  const url = "https://api.coingecko.com/api/v3/coins/list?include_platform=true";
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "bifrostwallet-assets-import" },
  });
  if (!response.ok) {
    throw new Error(`CoinGecko coins/list HTTP ${response.status}`);
  }
  const coins = (await response.json()) as CgCoin[];
  const map = new Map<string, string>();
  for (const coin of coins) {
    if (!coin.platforms) continue;
    for (const [platform, address] of Object.entries(coin.platforms)) {
      if (!address || typeof address !== "string") continue;
      const key = `${platform}:${address.toLowerCase()}`;
      // First win — avoid flipping ids on ambiguous multi-listings
      if (!map.has(key)) map.set(key, coin.id);
    }
  }
  return map;
}

function resolveCoingeckoId(
  chainId: number,
  address: string | null,
  custom: Map<string, string>,
  cgPlatform: Map<string, string> | null,
): string | null {
  const localKey = address === null ? `${chainId}:native` : `${chainId}:${address}`;
  const fromCustom = custom.get(localKey);
  if (fromCustom) return fromCustom;

  if (!cgPlatform || address === null) return null;
  const platform = CG_PLATFORM_BY_CHAIN[chainId];
  if (!platform) return null;
  return cgPlatform.get(`${platform}:${address}`) ?? null;
}

function resolveLogoPath(tokensRepo: string, logoURI: string): string {
  const rel = logoURI.replace(/^\.\//, "");
  return path.join(tokensRepo, rel);
}

function writeTokenEntry(
  tokensRepo: string,
  chainId: number,
  draft: Omit<TokenInfo, "logoURL" | "logoHash"> & { logoURI: string },
  report: ImportReport,
): void {
  const chainPath = caip2Path(chainId);
  const dirName = tokenDirName(draft.address);
  const entryDir = path.join(process.cwd(), "data", "tokens", chainPath, dirName);
  fs.mkdirSync(entryDir, { recursive: true });

  const logoRel = tokenLogoRelativePath(chainPath, dirName);
  const logoAbs = path.join(entryDir, "logo.webp");
  const srcLogo = resolveLogoPath(tokensRepo, draft.logoURI);
  const label = `${chainPath}/${dirName}`;

  let logoHash = "";
  if (!fs.existsSync(srcLogo)) {
    report.missingLogos.push(label);
  } else {
    try {
      const webp = encodePngFileToWebp(srcLogo, {
        resize: {
          width: ASSET_LOGO_REQUIREMENTS.WIDTH,
          height: ASSET_LOGO_REQUIREMENTS.HEIGHT,
        },
      });
      fs.writeFileSync(logoAbs, webp);
      logoHash = sha256Hex(webp);
      const check = isValidImage(logoAbs, {
        maxSizeKB: ASSET_LOGO_REQUIREMENTS.MAX_SIZE_KB,
        minWidth: ASSET_LOGO_REQUIREMENTS.MIN_WIDTH,
        maxWidth: ASSET_LOGO_REQUIREMENTS.MAX_WIDTH,
        requireSquare: ASSET_LOGO_REQUIREMENTS.REQUIRE_SQUARE,
      });
      if (!check.isValid) {
        const dims = readWebpDimensions(webp);
        report.logoOutliers.push({
          path: logoRel,
          reason:
            check.errors.join("; ") ||
            `failed published checks (${dims?.width ?? "?"}x${dims?.height ?? "?"})`,
        });
      }
    } catch (error) {
      report.encodeFailures.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const info: TokenInfo = sortTokenInfo({
    name: draft.name,
    symbol: draft.symbol,
    decimals: draft.decimals,
    address: draft.address,
    coingeckoId: draft.coingeckoId,
    logoURL: logoRel,
    logoHash,
  });
  fs.writeFileSync(path.join(entryDir, "info.json"), `${JSON.stringify(info, null, 2)}\n`);

  report.imported += 1;
  report.byChain[chainPath] = (report.byChain[chainPath] ?? 0) + 1;
  if (draft.coingeckoId) report.coingeckoResolved += 1;
  else report.coingeckoNull += 1;
}

async function importTokens(): Promise<void> {
  const tokensRepo = resolveTokensRepo();
  const skipCg = process.argv.includes("--skip-coingecko");
  console.info(`📥 tokens repo: ${tokensRepo}`);

  const tokenlist = JSON.parse(
    fs.readFileSync(path.join(tokensRepo, "bifrost-wallet.tokenlist.json"), "utf8"),
  ) as { tokens: SourceErc20[] };
  const nativelist = JSON.parse(
    fs.readFileSync(path.join(tokensRepo, "bifrost-wallet.nativelist.json"), "utf8"),
  ) as { tokens: SourceNative[] };
  const blocklistRaw = JSON.parse(
    fs.readFileSync(path.join(tokensRepo, "bifrost-wallet.blocklist.json"), "utf8"),
  ) as { tokens: SourceBlock[] };

  const custom = buildCustomIdMap();
  let cgPlatform: Map<string, string> | null = null;
  if (skipCg) {
    console.warn("⚠️  --skip-coingecko: coingeckoId from custom overrides only");
  } else {
    console.info("🔎 Fetching CoinGecko coins/list?include_platform=true …");
    cgPlatform = await fetchCoingeckoPlatformIndex();
    console.info(`   indexed ${cgPlatform.size} platform addresses`);
  }

  const dataRoot = path.join(process.cwd(), "data", "tokens");
  if (fs.existsSync(dataRoot)) {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(dataRoot, { recursive: true });

  const report: ImportReport = {
    tokensRepo,
    imported: 0,
    natives: 0,
    erc20: 0,
    blocklist: 0,
    coingeckoResolved: 0,
    coingeckoNull: 0,
    missingLogos: [],
    encodeFailures: [],
    logoOutliers: [],
    byChain: {},
  };

  for (const native of nativelist.tokens) {
    const coingeckoId = resolveCoingeckoId(native.chainId, null, custom, cgPlatform);
    writeTokenEntry(
      tokensRepo,
      native.chainId,
      {
        name: native.name,
        symbol: native.symbol,
        decimals: native.decimals,
        address: null,
        coingeckoId,
        logoURI: native.logoURI,
      },
      report,
    );
    report.natives += 1;
  }

  for (const token of tokenlist.tokens) {
    const address = token.address.toLowerCase();
    const coingeckoId = resolveCoingeckoId(token.chainId, address, custom, cgPlatform);
    writeTokenEntry(
      tokensRepo,
      token.chainId,
      {
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        address,
        coingeckoId,
        logoURI: token.logoURI,
      },
      report,
    );
    report.erc20 += 1;
  }

  const blocklist: TokenBlocklistEntry[] = blocklistRaw.tokens.map((entry) => ({
    chainPath: caip2Path(entry.chainID),
    address: entry.address.toLowerCase(),
    identifier: entry.identifier,
  }));
  report.blocklist = blocklist.length;
  fs.writeFileSync(
    path.join(dataRoot, "blocklist.json"),
    `${JSON.stringify({ tokens: blocklist }, null, 2)}\n`,
  );

  rebuildAllTokensAllJson();

  const reportsDir = path.join(process.cwd(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, "tokens-import.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.info(
    `\n✅ Imported ${report.imported} tokens (${report.natives} native, ${report.erc20} erc20)`,
  );
  console.info(`   coingeckoId set: ${report.coingeckoResolved}, null: ${report.coingeckoNull}`);
  console.info(`   blocklist: ${report.blocklist}`);
  console.info(`   missing logos: ${report.missingLogos.length}`);
  console.info(`   encode failures: ${report.encodeFailures.length}`);
  console.info(`   logo outliers: ${report.logoOutliers.length}`);
  console.info(`   report: ${reportPath}`);
}

if (isMain(import.meta.url)) {
  importTokens().catch((error) => {
    console.error("❌ Token import failed:", error);
    process.exitCode = 1;
  });
}

export default importTokens;
