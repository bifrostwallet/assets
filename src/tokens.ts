import * as fs from "node:fs";
import * as path from "node:path";
import { writeFormattedJson } from "./convert.js";

/**
 * Curated token entry (git `info.json`).
 * `coingeckoId` is always present: string for price/logo enrichment, or null when none.
 */
export type TokenInfo = {
  name: string;
  symbol: string;
  decimals: number;
  /** Lowercase 0x… for contracts; null for the chain native gas token */
  address: string | null;
  /** Required field — never omit. null = no CoinGecko mapping / no price feed */
  coingeckoId: string | null;
  logoURL: string;
  logoHash: string;
};

export type TokenBlocklistEntry = {
  chainPath: string;
  address: string;
  identifier: string;
};

export function caip2Path(chainId: number): string {
  return `eip155-${chainId}`;
}

export function tokenDirName(address: string | null): string {
  if (address === null) return "native";
  return address.toLowerCase();
}

export function tokenLogoRelativePath(chainPath: string, dirName: string): string {
  return `tokens/${chainPath}/${dirName}/logo.webp`;
}

export function sortTokenInfo(info: TokenInfo): TokenInfo {
  return {
    name: info.name,
    symbol: info.symbol,
    decimals: info.decimals,
    address: info.address,
    coingeckoId: info.coingeckoId,
    logoURL: info.logoURL,
    logoHash: info.logoHash,
  };
}

/** Reject catalogs that omit coingeckoId (hydration contract). */
export function assertTokenCoingeckoIdField(
  info: unknown,
  label: string,
): asserts info is TokenInfo {
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

export function listTokenChainPaths(): string[] {
  const root = path.join(process.cwd(), "data", "tokens");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("eip155-"))
    .map((e) => e.name)
    .sort();
}

export function listTokenDirs(chainPath: string): { dirName: string; dir: string }[] {
  const chainDir = path.join(process.cwd(), "data", "tokens", chainPath);
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

export function loadTokenInfo(infoPath: string): TokenInfo {
  const raw: unknown = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  assertTokenCoingeckoIdField(raw, infoPath);
  return raw;
}

export function rebuildTokensAllJson(chainPath: string): TokenInfo[] {
  const tokens = listTokenDirs(chainPath).map(({ dir }) =>
    sortTokenInfo(loadTokenInfo(path.join(dir, "info.json"))),
  );
  const allPath = path.join(process.cwd(), "data", "tokens", chainPath, "all.json");
  writeFormattedJson(allPath, tokens);
  return tokens;
}

export function rebuildAllTokensAllJson(): void {
  for (const chainPath of listTokenChainPaths()) {
    rebuildTokensAllJson(chainPath);
  }
}

export function loadBlocklist(): TokenBlocklistEntry[] {
  const p = path.join(process.cwd(), "data", "tokens", "blocklist.json");
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { tokens?: TokenBlocklistEntry[] };
  return raw.tokens ?? [];
}
