import * as fs from "node:fs";
import * as path from "node:path";
import { XRPL_MAINNET_CHAIN_PATH } from "./xrplToken.js";

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;

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
  return errors;
}

/** Catalog key order for an EVM `info.json` / `all.json` entry. */
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

/**
 * Insert one contract token into an `all.json` array.
 * Existing entries stay in place. The new address is inserted in lexicographic
 * order among contract addresses, and before the native gas token when that
 * entry is last.
 */
export function insertEvmToken(tokens: readonly EvmToken[], token: EvmToken): EvmToken[] {
  if (token.address === null) {
    throw new Error("add:token does not add the native gas token");
  }
  if (tokens.some((entry) => entry.address === token.address)) {
    throw new Error(`all.json already lists ${token.address}`);
  }
  const address = token.address;
  const next = [...tokens];
  let insertAt = next.length;
  for (let index = 0; index < next.length; index++) {
    const current = next[index]?.address;
    if (current === null || (typeof current === "string" && current.localeCompare(address) > 0)) {
      insertAt = index;
      break;
    }
  }
  next.splice(insertAt, 0, token);
  return next;
}
