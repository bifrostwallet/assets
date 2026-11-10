import * as fs from "node:fs";
import * as path from "node:path";
import { withRelativeLogoURL } from "./assetUrl.js";
import {
  listXrplTokenDirs,
  sortXrplToken,
  XRPL_MAINNET_CHAIN_PATH,
  type XrplToken,
} from "./xrplToken.js";

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const LOGO_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Curated EVM token (`data/tokens/eip155-<id>/`).
 * `coingeckoId` is always present: string for price/logo enrichment, or null when none.
 * `address` is a lowercase `0x` contract, or null for the native gas token.
 */
export type EvmToken = {
  name: string;
  symbol: string;
  decimals: number;
  /** Lowercase 0x… for contracts; null for the native gas token */
  address: string | null;
  /** Required field — never omit. null = no CoinGecko mapping / no price feed */
  coingeckoId: string | null;
  logoURL: string;
  logoHash: string;
};

/** Reject catalogs that omit coingeckoId (hydration contract). */
export function assertTokenCoingeckoIdField(
  info: unknown,
  label: string,
): asserts info is EvmToken {
  if (!info || typeof info !== "object") {
    throw new Error(`${label}: not an object`);
  }
  const record = info as Record<string, unknown>;
  if (!("coingeckoId" in record)) {
    throw new Error(`${label}: missing required coingeckoId (use string or null)`);
  }
  const id = record.coingeckoId;
  if (id !== null && typeof id !== "string") {
    throw new Error(`${label}: coingeckoId must be string or null`);
  }
  if (typeof id === "string" && id.trim() === "") {
    throw new Error(`${label}: coingeckoId string must be non-empty (or null)`);
  }
}

export function listTokenChainPaths(root = process.cwd()): string[] {
  const tokensRoot = path.join(root, "data", "tokens");
  if (!fs.existsSync(tokensRoot)) return [];
  return fs
    .readdirSync(tokensRoot, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() && (e.name.startsWith("eip155-") || e.name === XRPL_MAINNET_CHAIN_PATH),
    )
    .map((e) => e.name)
    .sort();
}

/** One directory per EVM token (`<address>` or `native`). XRPL is two levels deep. */
export function listTokenDirs(
  chainPath: string,
  root = process.cwd(),
): { dirName: string; dir: string }[] {
  const chainDir = path.join(root, "data", "tokens", chainPath);
  if (!fs.existsSync(chainDir)) return [];
  const out: { dirName: string; dir: string }[] = [];
  for (const entry of fs.readdirSync(chainDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(chainDir, entry.name);
    if (!fs.existsSync(path.join(dir, "info.json"))) continue;
    out.push({ dirName: entry.name, dir });
  }
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

export function loadEvmToken(infoPath: string): EvmToken {
  const raw: unknown = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  assertTokenCoingeckoIdField(raw, infoPath);
  return raw;
}

/**
 * Schema errors for one EVM token. Empty means the entry matches the catalog
 * rules. Does not read the logo file and does not reject unknown fields.
 */
export function validateEvmToken(info: unknown): string[] {
  const errors: string[] = [];
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    return ["not an object"];
  }
  const record = info as Record<string, unknown>;
  const { name, symbol, decimals, address } = record;

  if (typeof name !== "string" || !name.trim()) errors.push("invalid name");
  if (typeof symbol !== "string" || !symbol.trim()) errors.push("invalid symbol");
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0) {
    errors.push("invalid decimals");
  }
  if (address === null) {
    // Native gas token — no contract address.
  } else if (typeof address !== "string" || !EVM_ADDRESS.test(address)) {
    errors.push("address must be lowercase 0x…40 or null (native)");
  }
  if (!("coingeckoId" in record)) {
    errors.push("missing required coingeckoId (use string or null)");
  } else if (record.coingeckoId !== null && typeof record.coingeckoId !== "string") {
    errors.push("coingeckoId must be string or null");
  } else if (typeof record.coingeckoId === "string" && record.coingeckoId.trim() === "") {
    errors.push("coingeckoId string must be non-empty (or null)");
  }
  let folder = "";
  if (address === null) folder = "native";
  else if (typeof address === "string") folder = address;
  if (folder !== "") {
    const logoPattern = new RegExp(`^tokens\\/[^/]+\\/${folder}\\/logo\\.webp$`);
    if (typeof record.logoURL !== "string" || !logoPattern.test(record.logoURL)) {
      errors.push(`logoURL must be tokens/<chain>/${folder}/logo.webp`);
    }
  }
  if (typeof record.logoHash !== "string" || !LOGO_HASH_RE.test(record.logoHash)) {
    errors.push("logoHash must be a lowercase SHA-256 hex digest");
  }
  return errors;
}

/** Catalog key order for an EVM `info.json` entry. */
export function sortEvmToken(token: EvmToken): EvmToken {
  return {
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    address: token.address,
    coingeckoId: token.coingeckoId,
    logoURL: token.logoURL,
    logoHash: token.logoHash,
  };
}

/** Contract addresses sort lexicographically. The native gas token (`address: null`) is last. */
function compareEvmToken(a: EvmToken, b: EvmToken): number {
  if (a.address === b.address) return 0;
  if (a.address === null) return 1;
  if (b.address === null) return -1;
  return a.address.localeCompare(b.address);
}

/**
 * Tokens for one chain, in package order.
 * EVM entries are sorted by address, native last. XRPL entries are issuer, then currency.
 * `logoURL` stays the relative path from `info.json`.
 */
export function listChainTokens(chainPath: string, root = process.cwd()): EvmToken[] | XrplToken[] {
  if (chainPath === XRPL_MAINNET_CHAIN_PATH) {
    return listXrplTokenDirs(root).map(({ dir }) => {
      const info = JSON.parse(fs.readFileSync(path.join(dir, "info.json"), "utf8")) as XrplToken;
      return withRelativeLogoURL(sortXrplToken(info));
    });
  }
  return listTokenDirs(chainPath, root)
    .map(({ dir }) => withRelativeLogoURL(sortEvmToken(loadEvmToken(path.join(dir, "info.json")))))
    .sort(compareEvmToken);
}
