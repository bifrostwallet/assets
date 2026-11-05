import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAddress } from "viem";
import { ASSET_LOGO_REQUIREMENTS } from "./config.js";
import { isValidImage } from "./validate.js";
import { encodeImageFileToWebp, isWebpMagic, readWebpDimensions } from "./webp.js";

/** CoinGecko `asset_platform_id` for chains that already have a `*_NODE_URL`. */
export const COINGECKO_PLATFORM_BY_CHAIN: Readonly<Record<number, string>> = {
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
  999: "hyperevm",
};

/**
 * `trustwallet/assets` blockchain folder. Flare and Songbird are not in that
 * repository, so those chains can only take a CoinGecko icon.
 */
export const TRUSTWALLET_BLOCKCHAIN_BY_CHAIN: Readonly<Record<number, string>> = {
  1: "ethereum",
  10: "optimism",
  50: "xdc",
  56: "smartchain",
  137: "polygon",
  250: "fantom",
  8453: "base",
  42161: "arbitrum",
  999: "hyperevm",
};

const COINGECKO_CONTRACT = "https://api.coingecko.com/api/v3/coins";
const TRUSTWALLET_RAW = "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains";

const MAX_LOGO_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const WEBP_QUALITIES = [85, 75, 65, 55, 45, 35, 25];

export class TokenLogoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenLogoError";
  }
}

export type TokenLogo = {
  bytes: Buffer;
  coingeckoId: string | null;
  source: "coingecko" | "trustwallet";
};

export function coinGeckoContractUrl(chainId: number, address: string): string | null {
  const platform = COINGECKO_PLATFORM_BY_CHAIN[chainId];
  if (!platform) return null;
  return `${COINGECKO_CONTRACT}/${platform}/contract/${address.toLowerCase()}`;
}

export function trustWalletLogoUrl(chainId: number, address: string): string | null {
  const blockchain = TRUSTWALLET_BLOCKCHAIN_BY_CHAIN[chainId];
  if (!blockchain) return null;
  return `${TRUSTWALLET_RAW}/${blockchain}/assets/${getAddress(address)}/logo.png`;
}

export function coinGeckoImageFromPayload(payload: unknown): {
  id: string | null;
  imageUrl: string | null;
} {
  if (!payload || typeof payload !== "object") return { id: null, imageUrl: null };
  const record = payload as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() !== "" ? record.id.trim() : null;
  const image = record.image;
  if (!image || typeof image !== "object") return { id, imageUrl: null };
  const sizes = image as Record<string, unknown>;
  for (const key of ["large", "small", "thumb"]) {
    const value = sizes[key];
    if (typeof value === "string" && value.startsWith("https://")) {
      return { id, imageUrl: value };
    }
  }
  return { id, imageUrl: null };
}

function imageExtension(bytes: Buffer): "png" | "jpg" | "webp" {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  if (isWebpMagic(bytes)) return "webp";
  throw new TokenLogoError("Logo is not a PNG, JPEG, or WebP file");
}

function isCatalogWebp(bytes: Buffer): boolean {
  if (!isWebpMagic(bytes)) return false;
  const dims = readWebpDimensions(bytes);
  return (
    dims?.width === ASSET_LOGO_REQUIREMENTS.WIDTH &&
    dims.height === ASSET_LOGO_REQUIREMENTS.HEIGHT &&
    bytes.length / 1024 <= ASSET_LOGO_REQUIREMENTS.MAX_SIZE_KB
  );
}

/** Resize and compress logo bytes to the catalog WebP (128×128, at most 24 KB). */
export function convertLogoBytesToWebp(bytes: Buffer): Buffer {
  if (isCatalogWebp(bytes)) return Buffer.from(bytes);
  const ext = imageExtension(bytes);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-token-logo-"));
  try {
    const input = path.join(dir, `source.${ext}`);
    fs.writeFileSync(input, bytes);
    let lastErrors: string[] = ["Logo could not be converted"];
    for (const quality of WEBP_QUALITIES) {
      let webp: Buffer;
      try {
        webp = encodeImageFileToWebp(input, {
          quality,
          resize: {
            width: ASSET_LOGO_REQUIREMENTS.WIDTH,
            height: ASSET_LOGO_REQUIREMENTS.HEIGHT,
          },
        });
      } catch (error) {
        throw new TokenLogoError(
          `Could not convert logo to WebP: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const out = path.join(dir, `logo-${quality}.webp`);
      fs.writeFileSync(out, webp);
      const check = isValidImage(out, {
        maxSizeKB: ASSET_LOGO_REQUIREMENTS.MAX_SIZE_KB,
        minWidth: ASSET_LOGO_REQUIREMENTS.MIN_WIDTH,
        maxWidth: ASSET_LOGO_REQUIREMENTS.MAX_WIDTH,
        requireSquare: ASSET_LOGO_REQUIREMENTS.REQUIRE_SQUARE,
      });
      if (check.isValid) return webp;
      lastErrors = check.errors;
      const sizeOnly = check.errors.every((error) => error.startsWith("File exceeds maximum size"));
      if (!sizeOnly) break;
    }
    throw new TokenLogoError(`Logo validation failed: ${lastErrors.join("; ")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

async function downloadImage(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new HttpStatusError(response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new TokenLogoError("Logo download was empty");
  if (bytes.length > MAX_LOGO_DOWNLOAD_BYTES) {
    throw new TokenLogoError("Logo download is larger than 8 MB");
  }
  return bytes;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Logo for one contract. CoinGecko is tried first. Trust Wallet is the fallback
 * when CoinGecko has no icon or the icon cannot be converted.
 */
export async function fetchTokenLogo(args: {
  chainId: number;
  address: string;
  fetchImpl?: typeof fetch;
  convertLogo?: (bytes: Buffer) => Buffer;
}): Promise<TokenLogo> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const convert = args.convertLogo ?? convertLogoBytesToWebp;
  const address = args.address.toLowerCase();
  const cgUrl = coinGeckoContractUrl(args.chainId, address);
  let coingeckoId: string | null = null;
  let coingeckoNote = "CoinGecko has no platform for this chain";

  if (cgUrl) {
    try {
      const response = await fetchImpl(cgUrl, {
        signal: AbortSignal.timeout(20_000),
        headers: {
          accept: "application/json",
          "user-agent": "bifrostwallet-assets/add-token",
        },
      });
      if (response.status === 404) {
        coingeckoNote = "CoinGecko has no icon for this contract";
      } else if (!response.ok) {
        coingeckoNote = `CoinGecko lookup failed (HTTP ${response.status})`;
      } else {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = null;
          coingeckoNote = "CoinGecko returned invalid JSON";
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          coingeckoNote = "CoinGecko returned invalid JSON";
        } else {
          const parsed = coinGeckoImageFromPayload(payload);
          coingeckoId = parsed.id;
          if (!parsed.imageUrl) {
            coingeckoNote = "CoinGecko has no icon for this contract";
          } else {
            try {
              const bytes = await downloadImage(parsed.imageUrl, fetchImpl);
              return { bytes: convert(bytes), coingeckoId, source: "coingecko" };
            } catch (error) {
              coingeckoNote = `CoinGecko icon could not be used (${errorText(error)})`;
            }
          }
        }
      }
    } catch (error) {
      coingeckoNote = `CoinGecko lookup failed (${errorText(error)})`;
    }
  }

  const trustUrl = trustWalletLogoUrl(args.chainId, address);
  if (!trustUrl) {
    throw new TokenLogoError(
      `No logo for ${address} on eip155-${args.chainId}. ${coingeckoNote}, and Trust Wallet's assets repository has no catalog for this chain.`,
    );
  }
  try {
    const bytes = await downloadImage(trustUrl, fetchImpl);
    return { bytes: convert(bytes), coingeckoId, source: "trustwallet" };
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 404) {
      throw new TokenLogoError(
        `No logo for ${address} on eip155-${args.chainId}. ${coingeckoNote}, and Trust Wallet has no logo for this contract.`,
      );
    }
    throw new TokenLogoError(
      `No logo for ${address} on eip155-${args.chainId}. ${coingeckoNote}. Trust Wallet logo was not usable (${errorText(error)}).`,
    );
  }
}
