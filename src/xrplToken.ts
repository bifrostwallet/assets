import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import bs58 from "bs58";

/** Mainnet only. CAIP-2 `xrpl:0`, repo path `xrpl-0`. */
export const XRPL_MAINNET_CHAIN_PATH = "xrpl-0";

const BITCOIN_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RIPPLE_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

/** 3-character XRPL currency, excluding the reserved code `XRP`. */
const STANDARD_CURRENCY = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;
const HEX_CURRENCY = /^[0-9A-F]{40}$/;

/** First byte of an AMM LP token currency code. Those are not catalog entries. */
const AMM_LP_CURRENCY_PREFIX = 0x03;
const AMM_LP_CURRENCY = /^03[0-9A-Fa-f]{38}$/;

const XRPL_TOKEN_KEYS = [
  "name",
  "symbol",
  "issuer",
  "currency",
  "coingeckoId",
  "logoURL",
  "logoHash",
] as const;

/**
 * Issued token on XRPL mainnet. Identified by `issuer` and `currency`.
 * There is no `address` field. Amounts use the ledger float, so there is no
 * `decimals` field.
 */
export type XrplToken = {
  name: string;
  symbol: string;
  /** Classic r-address, exact case. */
  issuer: string;
  /** On-ledger currency: 3-character exact case, or 40-hex uppercase. */
  currency: string;
  coingeckoId: string | null;
  logoURL: string;
  logoHash: string;
};

export type XrplTokenDir = {
  issuerDir: string;
  currencyDir: string;
  dir: string;
};

/**
 * Classic account r-address: ripple base58, version byte 0, 20-byte payload,
 * 4-byte double-SHA-256 checksum. Case is significant.
 */
export function isValidXrplAccountAddress(address: string): boolean {
  if (address.length < 25 || address.length > 35) return false;
  let mapped = "";
  for (const char of address) {
    const index = RIPPLE_ALPHABET.indexOf(char);
    if (index < 0) return false;
    const bitcoinChar = BITCOIN_ALPHABET[index];
    if (bitcoinChar === undefined) return false;
    mapped += bitcoinChar;
  }
  try {
    const decoded = Buffer.from(bs58.decode(mapped));
    if (decoded.length !== 25 || decoded[0] !== 0x00) return false;
    const payload = decoded.subarray(0, 21);
    const checksum = decoded.subarray(21);
    const hash = createHash("sha256")
      .update(createHash("sha256").update(payload).digest())
      .digest();
    return checksum.equals(hash.subarray(0, 4));
  } catch {
    return false;
  }
}

/**
 * On-ledger currency as the catalog symbol.
 * 3-character codes stay in exact case. 40-hex codes (uppercase, first byte
 * not 0x00 and not an AMM LP token) decode as trailing-NUL-stripped ASCII.
 */
export function decodeXrplCurrency(currency: string): string | null {
  if (currency === "XRP") return null;
  if (STANDARD_CURRENCY.test(currency)) return currency;
  if (!HEX_CURRENCY.test(currency)) return null;
  const bytes = Buffer.from(currency, "hex");
  const prefix = bytes[0];
  if (prefix === undefined || prefix === 0x00 || prefix === AMM_LP_CURRENCY_PREFIX) return null;
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x00) end -= 1;
  if (end < 1 || end > 12) return null;
  for (let i = 0; i < end; i += 1) {
    const byte = bytes[i];
    if (byte === undefined || byte < 0x21 || byte > 0x7e) return null;
  }
  return bytes.subarray(0, end).toString("ascii");
}

/**
 * Directories and files under `xrpl-0` that are not `<issuer>/<currency>/`.
 * `all.json` is the only file allowed next to the issuer folders.
 */
export function xrplCatalogPathErrors(root = process.cwd()): string[] {
  const chainDir = path.join(root, "data", "tokens", XRPL_MAINNET_CHAIN_PATH);
  if (!fs.existsSync(chainDir)) return [`missing ${XRPL_MAINNET_CHAIN_PATH}`];
  const errors: string[] = [];
  for (const issuerEntry of fs.readdirSync(chainDir, { withFileTypes: true })) {
    if (issuerEntry.name === "all.json" && issuerEntry.isFile()) continue;
    const issuerLabel = `${XRPL_MAINNET_CHAIN_PATH}/${issuerEntry.name}`;
    if (!issuerEntry.isDirectory()) {
      errors.push(`${issuerLabel}: unexpected file`);
      continue;
    }
    const issuerPath = path.join(chainDir, issuerEntry.name);
    if (fs.existsSync(path.join(issuerPath, "info.json"))) {
      errors.push(`${issuerLabel}: expected <issuer>/<currency>/info.json`);
    }
    for (const currencyEntry of fs.readdirSync(issuerPath, { withFileTypes: true })) {
      const currencyLabel = `${issuerLabel}/${currencyEntry.name}`;
      if (!currencyEntry.isDirectory()) {
        errors.push(`${currencyLabel}: unexpected file`);
        continue;
      }
      if (!fs.existsSync(path.join(issuerPath, currencyEntry.name, "info.json"))) {
        errors.push(`${currencyLabel}: missing info.json`);
      }
    }
  }
  return errors;
}

/** `data/tokens/xrpl-0/<issuer>/<currency>/` entries that contain info.json. */
export function listXrplTokenDirs(root = process.cwd()): XrplTokenDir[] {
  const chainDir = path.join(root, "data", "tokens", XRPL_MAINNET_CHAIN_PATH);
  if (!fs.existsSync(chainDir)) return [];
  const out: XrplTokenDir[] = [];
  for (const issuerEntry of fs.readdirSync(chainDir, { withFileTypes: true })) {
    if (!issuerEntry.isDirectory()) continue;
    const issuerPath = path.join(chainDir, issuerEntry.name);
    for (const currencyEntry of fs.readdirSync(issuerPath, { withFileTypes: true })) {
      if (!currencyEntry.isDirectory()) continue;
      const dir = path.join(issuerPath, currencyEntry.name);
      if (!fs.existsSync(path.join(dir, "info.json"))) continue;
      out.push({ issuerDir: issuerEntry.name, currencyDir: currencyEntry.name, dir });
    }
  }
  return out.sort(
    (a, b) => a.issuerDir.localeCompare(b.issuerDir) || a.currencyDir.localeCompare(b.currencyDir),
  );
}

/**
 * Schema errors for one XRPL issued-token `info.json`. Empty means the entry
 * matches the catalog rules. `issuerDir` and `currencyDir` are the folder names
 * under `xrpl-0`. Pass `logoSha256` when logo.webp is present so the hash can
 * be checked.
 */
export function validateXrplToken(
  info: unknown,
  issuerDir: string,
  currencyDir: string,
  logoSha256?: string,
): string[] {
  const errors: string[] = [];
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    return ["not an object"];
  }
  const record = info as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!XRPL_TOKEN_KEYS.includes(key as (typeof XRPL_TOKEN_KEYS)[number])) {
      errors.push(`unexpected field ${key}`);
    }
  }

  const { name, symbol, issuer, currency, coingeckoId, logoURL, logoHash } = record;

  if (typeof issuer !== "string" || !isValidXrplAccountAddress(issuer)) {
    errors.push("issuer must be an exact-case classic r-address");
  }
  if (typeof issuer === "string" && issuerDir !== issuer) {
    errors.push(`folder ${issuerDir} must equal issuer ${issuer}`);
  }

  const currencyError =
    "currency must be a 3-character code in exact case (not XRP) or 40-hex uppercase (not an AMM LP token)";
  let decoded: string | null = null;
  if (typeof currency !== "string") {
    errors.push(currencyError);
  } else if (AMM_LP_CURRENCY.test(currency)) {
    errors.push("currency must not be an AMM LP token (40-hex starting with 03)");
  } else {
    decoded = decodeXrplCurrency(currency);
    if (decoded === null) errors.push(currencyError);
  }
  if (typeof currency === "string" && currencyDir !== currency) {
    errors.push(`folder ${currencyDir} must equal currency ${currency}`);
  }

  if (typeof name !== "string" || name.trim() === "" || name !== name.trim()) {
    errors.push("invalid name");
  }
  if (typeof symbol !== "string" || symbol !== decoded) {
    errors.push("symbol must be the decoded on-ledger currency code");
  }
  if (!("coingeckoId" in record)) {
    errors.push("missing required coingeckoId (use string or null)");
  } else if (
    coingeckoId !== null &&
    (typeof coingeckoId !== "string" || coingeckoId.trim() === "")
  ) {
    errors.push("coingeckoId must be a non-empty string or null");
  }
  if (typeof issuer === "string" && typeof currency === "string") {
    const expectedLogo = `tokens/${XRPL_MAINNET_CHAIN_PATH}/${issuer}/${currency}/logo.webp`;
    if (logoURL !== expectedLogo) errors.push(`logoURL must be ${expectedLogo}`);
  }
  if (typeof logoHash !== "string" || !/^[0-9a-f]{64}$/.test(logoHash)) {
    errors.push("logoHash must be a lowercase SHA-256 hex digest");
  } else if (logoSha256 !== undefined && logoHash !== logoSha256) {
    errors.push("logoHash does not match logo.webp");
  }

  return errors;
}
