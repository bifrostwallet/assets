import * as path from "node:path";
import { listTokenChainPaths, listTokenDirs, loadEvmToken } from "./tokens.js";

/**
 * On-chain strings that fail catalog rules. Distinct from a transport failure
 * so the curator sees the token problem instead of "could not read".
 */
export class TokenMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenMetadataError";
  }
}

export type SymbolUse = {
  chainPath: string;
  symbol: string;
  /** Lowercase contract address, or `native` for the gas token. */
  id: string;
};

/**
 * Duplicate symbols the catalog already carries. `check:tokens` allows these
 * exact id sets and rejects every other duplicate on an EVM chain. Do not add
 * another token to one of these symbols. cWBTC is the on-chain spelling of the
 * two Compound WBTC tokens. Bridged USDC on Optimism, Polygon, and Arbitrum
 * uses the on-chain symbol USDC, alongside native USDC. XRPL is omitted:
 * issued tokens share a currency code across issuers on purpose.
 */
export const GRANDFATHERED_DUPLICATE_SYMBOLS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  "eip155-1": {
    cWBTC: [
      "0xc11b1268c1a384e55c48c2391d8d480264a3a7f4",
      "0xccf4429db6322d5c611ee964527d42e5d685dd6a",
    ],
    GALA: [
      "0x15d4c048f83bd7e37d49ea4c83a07267ec4203da",
      "0xd1d2eb1b1e90b638588728b4130137d262c87cae",
    ],
    LIT: [
      "0xb59490ab09a0f526cc7305822ac65f2ab12f9723",
      "0xc5b3d3231001a776123194cf1290068e8b0c783b",
    ],
    OHM: [
      "0x383518188c0c6d7730d91b2c03a03c837814a899",
      "0x64aa3364f17a4d01c6f1751fd97c2bd3d7e7f1d5",
    ],
    PYR: [
      "0x430ef9263e76dae63c84292c3409d61c598e9682",
      "0x9534ad65fb398e27ac8f4251dae1780b989d136e",
    ],
    RPL: [
      "0xb4efd85c19999d84251304bda99e90b92300bd93",
      "0xd33526068d116ce69f19a9ee46f0bd304f21a51f",
    ],
    RSR: [
      "0x320623b8e4ff03373931769a31fc52a4e78b5d70",
      "0x8762db106b2c2a0bccb3a80d1ed41273552616e8",
    ],
    STMX: [
      "0xa62cc35625b0c8dc1faea39d33625bb4c15bd71c",
      "0xbe9375c6a420d2eeb258962efb95551a5b722803",
    ],
    UBSN: [
      "0x2859021ee7f2cb10162e67f33af2d22764b31aff",
      "0x86efc496dca70bcfd92d19194290e8457a375773",
    ],
    USDP: [
      "0x1456688345527be1f37e9e627da0837d6f08c925",
      "0x8e870d67f660d95d5be530380d0ec0bd388289e1",
    ],
  },
  "eip155-10": {
    USDC: [
      "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
      "0x7f5c764cbc14f9669b88837ca1490cca17c31607",
    ],
  },
  "eip155-11155111": {
    USDC: [
      "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
      "0x94a9d9ac8a22534e3faca9f4e7f2e2cf85d5e4c8",
    ],
  },
  "eip155-137": {
    BANANA: [
      "0x5d47baba0d66083c52009271faf3f50dcc01023c",
      "0xbc91347e80886453f3f8bbd6d7ac07c122d87735",
    ],
    USDC: [
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    ],
  },
  "eip155-42161": {
    USDC: [
      "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8",
    ],
  },
};

/** Trimmed display name. Internal spaces stay as they were on-chain. */
export function assertCuratedName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new TokenMetadataError("Name is empty after trimming whitespace");
  }
  return trimmed;
}

/**
 * Trimmed symbol, kept 1:1 with on-chain text, including spaces and `.`.
 */
export function assertCuratedSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed) {
    throw new TokenMetadataError("Symbol is empty after trimming whitespace");
  }
  return trimmed;
}

/** Every EVM token symbol in the catalog. XRPL issued tokens are not included. */
export function listEvmSymbolUses(root = process.cwd()): SymbolUse[] {
  const uses: SymbolUse[] = [];
  for (const chainPath of listTokenChainPaths(root)) {
    if (!chainPath.startsWith("eip155-")) continue;
    for (const { dirName, dir } of listTokenDirs(chainPath, root)) {
      const info = loadEvmToken(path.join(dir, "info.json"));
      if (typeof info.symbol !== "string") continue;
      const id = dirName === "native" || info.address === null ? "native" : info.address;
      uses.push({ chainPath, symbol: info.symbol, id });
    }
  }
  return uses;
}

function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = sortedIds(left);
  const sortedRight = sortedIds(right);
  return sortedLeft.every((id, index) => id === sortedRight[index]);
}

/**
 * Duplicate EVM symbols that are not an exact grandfathered set.
 * Empty means the catalog may keep the legacy duplicates and has no new ones.
 */
export function duplicateSymbolErrors(uses: readonly SymbolUse[]): string[] {
  const groups = new Map<string, Map<string, string[]>>();
  for (const use of uses) {
    let bySymbol = groups.get(use.chainPath);
    if (!bySymbol) {
      bySymbol = new Map();
      groups.set(use.chainPath, bySymbol);
    }
    const ids = bySymbol.get(use.symbol) ?? [];
    ids.push(use.id);
    bySymbol.set(use.symbol, ids);
  }

  const errors: string[] = [];
  for (const [chainPath, bySymbol] of groups) {
    for (const [symbol, ids] of bySymbol) {
      if (ids.length < 2) continue;
      const allowed = GRANDFATHERED_DUPLICATE_SYMBOLS[chainPath]?.[symbol];
      if (allowed && sameIds(allowed, ids)) continue;
      errors.push(
        `${chainPath}: symbol ${JSON.stringify(symbol)} is used by ${sortedIds(ids).join(", ")}`,
      );
    }
  }
  return errors;
}

/** Groups of size > 1, as `chain`, `symbol`, sorted ids. Used to lock the grandfather list. */
export function duplicateSymbolGroups(
  uses: readonly SymbolUse[],
): { chainPath: string; symbol: string; ids: string[] }[] {
  const groups = new Map<string, Map<string, string[]>>();
  for (const use of uses) {
    let bySymbol = groups.get(use.chainPath);
    if (!bySymbol) {
      bySymbol = new Map();
      groups.set(use.chainPath, bySymbol);
    }
    const ids = bySymbol.get(use.symbol) ?? [];
    ids.push(use.id);
    bySymbol.set(use.symbol, ids);
  }
  const found: { chainPath: string; symbol: string; ids: string[] }[] = [];
  for (const [chainPath, bySymbol] of [...groups.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    for (const [symbol, ids] of [...bySymbol.entries()].sort((left, right) =>
      left[0].localeCompare(right[0]),
    )) {
      if (ids.length < 2) continue;
      found.push({ chainPath, symbol, ids: sortedIds(ids) });
    }
  }
  return found;
}
