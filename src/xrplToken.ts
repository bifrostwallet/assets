import { createHash } from "node:crypto";
import bs58 from "bs58";

/** Mainnet only. CAIP-2 `xrpl:0`, repo path `xrpl-0`. */
export const XRPL_MAINNET_CHAIN_PATH = "xrpl-0";

/**
 * IOU folder and `address` key: exact-case issuer, a dot, then the on-ledger
 * currency code. CoinGecko stores the reverse order (`<currency>.<issuer>`).
 */
export function xrplIouKey(issuer: string, currency: string): string {
  return `${issuer}.${currency}`;
}

const BITCOIN_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RIPPLE_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";

/** 3-character XRPL currency, excluding the reserved code `XRP`. */
const STANDARD_CURRENCY = /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/;
const HEX_CURRENCY = /^[0-9A-F]{40}$/;

/** First byte of an AMM LP token currency code. Those are not catalog entries. */
const AMM_LP_CURRENCY_PREFIX = 0x03;

const XRPL_IOU_KEYS = [
  "name",
  "symbol",
  "decimals",
  "address",
  "issuer",
  "currency",
  "coingeckoId",
  "logoURL",
  "logoHash",
] as const;

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

export type XrplIouInfo = {
  name: string;
  symbol: string;
  decimals: number;
  address: string;
  issuer: string;
  currency: string;
  coingeckoId: string | null;
  logoURL: string;
  logoHash: string;
};

/**
 * Schema errors for one XRPL IOU `info.json`. Empty means the entry matches
 * the catalog rules. Does not read the logo bytes; pass `logoSha256` when the
 * file is present so the hash can be checked.
 */
export function validateXrplIouInfo(info: unknown, dirName: string, logoSha256?: string): string[] {
  const errors: string[] = [];
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    return ["not an object"];
  }
  const record = info as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!XRPL_IOU_KEYS.includes(key as (typeof XRPL_IOU_KEYS)[number])) {
      errors.push(`unexpected field ${key}`);
    }
  }

  const { name, symbol, decimals, address, issuer, currency, coingeckoId, logoURL, logoHash } =
    record;

  if (typeof issuer !== "string" || !isValidXrplAccountAddress(issuer)) {
    errors.push("issuer must be an exact-case classic r-address");
  }
  const decoded = typeof currency === "string" ? decodeXrplCurrency(currency) : null;
  if (typeof currency !== "string" || decoded === null) {
    errors.push(
      "currency must be a 3-character code in exact case (not XRP) or 40-hex uppercase (not an AMM LP token)",
    );
  }
  const key =
    typeof issuer === "string" && typeof currency === "string" ? xrplIouKey(issuer, currency) : "";
  if (typeof address !== "string" || address !== key || key === "") {
    errors.push("address must equal issuer.currency in exact case");
  } else if (dirName !== address) {
    errors.push(`folder ${dirName} must equal address ${address}`);
  }

  if (typeof name !== "string" || name.trim() === "" || name !== name.trim()) {
    errors.push("invalid name");
  }
  if (typeof symbol !== "string" || symbol !== decoded) {
    errors.push("symbol must be the decoded on-ledger currency code");
  }
  if (
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 15
  ) {
    errors.push("decimals must be an integer from 0 through 15");
  }
  if (!("coingeckoId" in record)) {
    errors.push("missing required coingeckoId (use string or null)");
  } else if (
    coingeckoId !== null &&
    (typeof coingeckoId !== "string" || coingeckoId.trim() === "")
  ) {
    errors.push("coingeckoId must be a non-empty string or null");
  }
  if (typeof address === "string" && address !== "") {
    const expectedLogo = `tokens/${XRPL_MAINNET_CHAIN_PATH}/${address}/logo.webp`;
    if (logoURL !== expectedLogo) errors.push(`logoURL must be ${expectedLogo}`);
  }
  if (typeof logoHash !== "string" || !/^[0-9a-f]{64}$/.test(logoHash)) {
    errors.push("logoHash must be a lowercase SHA-256 hex digest");
  } else if (logoSha256 !== undefined && logoHash !== logoSha256) {
    errors.push("logoHash does not match logo.webp");
  }

  return errors;
}
