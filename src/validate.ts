import fs from "node:fs";
import { getAddress } from "viem";
import { type AllowedLink, PROVIDER_LOGO_REQUIREMENTS } from "./config.js";
import { isWebpMagic, readWebpDimensions } from "./webp.js";

export type HexString = `0x${string}`;

/**
 * Validates an EVM address format and its EIP-55 checksum if present
 * @param address The EVM address to validate
 * @returns True if the address is valid, false otherwise
 */
export function isValidEvmAddress(address: string): boolean {
  // Basic format check: 0x followed by 40 hex characters
  const basicFormatRegex = /^0x[0-9a-fA-F]{40}$/;
  if (!basicFormatRegex.test(address)) {
    return false;
  }

  // If the address is all lowercase or all uppercase, it doesn't use checksum
  // In this case, basic format validation is sufficient
  if (/^0x[0-9a-f]{40}$/.test(address) || /^0x[0-9A-F]{40}$/.test(address)) {
    return true;
  }

  // For mixed-case addresses, validate the EIP-55 checksum
  try {
    // getAddress will throw if the checksum is invalid
    const checksumAddress = getAddress(address);
    return checksumAddress === address;
  } catch (_error) {
    return false;
  }
}

/**
 * Default / shared hosting and social hostnames. Provider/dapp website URLs
 * must use a domain the operator controls (custom domain), not a platform
 * default like `*.vercel.app` or `*.run.app`. Keep in sync with the listing
 * intake website denylist.
 */
export const PLATFORM_WEBSITE_HOST_SUFFIXES = [
  // PaaS / edge defaults
  "vercel.app",
  "vercel.dev",
  "netlify.app",
  "pages.dev",
  "workers.dev",
  "trycloudflare.com",
  "herokuapp.com",
  "onrender.com",
  "railway.app",
  "fly.dev",
  "deno.dev",
  "surge.sh",
  "ngrok.io",
  "ngrok-free.app",
  "ngrok.app",
  // GCP / Firebase
  "run.app",
  "appspot.com",
  "cloudfunctions.net",
  "web.app",
  "firebaseapp.com",
  "googleusercontent.com",
  "sites.google.com",
  // AWS
  "amazonaws.com",
  "amplifyapp.com",
  "elasticbeanstalk.com",
  "cloudfront.net",
  "awsapprunner.com",
  // Azure
  "azurewebsites.net",
  "azurestaticapps.net",
  "blob.core.windows.net",
  // Other cloud / BaaS project hosts
  "ondigitalocean.app",
  "digitaloceanspaces.com",
  "supabase.co",
  "supabase.in",
  // Git host pages / profiles
  "github.io",
  "github.com",
  "githubusercontent.com",
  "gitlab.io",
  "gitlab.com",
  "bitbucket.io",
  "bitbucket.org",
  // Site builders / link-in-bio
  "notion.site",
  "notion.so",
  "medium.com",
  "substack.com",
  "linktr.ee",
  "carrd.co",
  "webflow.io",
  "framer.website",
  "framer.app",
  "myshopify.com",
  "wordpress.com",
  "blogspot.com",
  "wixsite.com",
  // Social (use links.* fields instead)
  "twitter.com",
  "x.com",
  "t.me",
  "telegram.me",
  "discord.gg",
  "discord.com",
  "youtube.com",
  "youtu.be",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "reddit.com",
] as const;

/** True when hostname is a shared platform default, not an owned brand domain. */
export function isPlatformWebsiteHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  return PLATFORM_WEBSITE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/**
 * Validates a URL according to specific rules for different types
 * @param url The URL string to validate
 * @param type The type of URL to validate (website or social link)
 * @returns True if the URL format is valid, false otherwise
 */
export function isValidURL(url: string, type: "website" | AllowedLink): boolean {
  if (url.length > 128) {
    return false;
  }

  const protocol = "https:\\/\\/";
  const domainStart = "[a-z0-9][-a-z0-9.]*";
  const tld = "\\.[a-z0-9][-a-z0-9.]*";
  const pathSegments = "(?:\\/[-a-zA-Z0-9.]+)*";
  const optionalTrailingSlash = "\\/?";

  if (type === "website") {
    const validUrlRegex = new RegExp(
      `^${protocol}${domainStart}${tld}${pathSegments}${optionalTrailingSlash}$`,
    );
    if (!validUrlRegex.test(url)) return false;
    try {
      const host = new URL(url).hostname;
      return !isPlatformWebsiteHostname(host);
    } catch {
      return false;
    }
  }

  // Updated links patterns with more lenient rules
  const platformPatterns: Record<string, RegExp> = {
    x: new RegExp(`^${protocol}x\\.com\\/[a-zA-Z0-9_\\-\\.]{1,15}${optionalTrailingSlash}$`),
    linkedin: new RegExp(
      `^${protocol}www\\.linkedin\\.com\\/(in\\/[a-zA-Z0-9_\\-\\.]+|company\\/[a-zA-Z0-9_\\-\\.]+)${optionalTrailingSlash}$`,
    ),
    reddit: new RegExp(
      `^${protocol}www\\.reddit\\.com\\/(user\\/[a-zA-Z0-9_\\-\\.]+|r\\/[a-zA-Z0-9_\\-\\.]+)${optionalTrailingSlash}$`,
    ),
    youtube: new RegExp(
      `^${protocol}www\\.youtube\\.com\\/((@|c\\/|channel\\/)[a-zA-Z0-9_\\-]+)${optionalTrailingSlash}$`,
    ),
    discord: new RegExp(`^${protocol}discord\\.gg\\/[a-zA-Z0-9_\\-\\.]+${optionalTrailingSlash}$`),
    // Updated Telegram regex to allow for invite links with special characters
    telegram: new RegExp(
      `^${protocol}t\\.me\\/([a-zA-Z0-9_\\-\\.]{5,32}|\\+[a-zA-Z0-9_\\-\\.]+)${optionalTrailingSlash}$`,
    ),
    github: new RegExp(`^${protocol}github\\.com\\/[a-zA-Z0-9_\\-\\.]+${optionalTrailingSlash}$`),
    tiktok: new RegExp(
      `^${protocol}www\\.tiktok\\.com\\/@[a-zA-Z0-9_\\.]{1,24}${optionalTrailingSlash}$`,
    ),
  };

  const pattern = platformPatterns[type];
  if (pattern) {
    return pattern.test(url);
  }

  return false;
}

/**
 * Validates a name string according to specific rules
 * @param name The name string to validate
 * @returns True if the name format is valid, false otherwise
 * @remarks
 * Valid names must:
 * - Contain only alphanumeric characters, spaces, and certain special characters (.'+-%/À-ÖØ-öø-ÿ:&()[])
 * - Be between 2 and 32 characters in length
 * - Not have leading or trailing whitespace
 */
export function isValidName(name: string): boolean {
  // Check for leading or trailing whitespace
  if (name !== name.trim()) {
    return false;
  }

  const nameRegex = /^[a-zA-Z0-9 .'+\-%/À-ÖØ-öø-ÿ:&()[\]?{};~!_@]{2,32}$/;
  return nameRegex.test(name);
}

/**
 * Printable ASCII only (0x20–0x7E), length 10–350.
 * Keep in sync with assets-intake apps/add validation + intake DESCRIPTION_RE.
 */
export function isValidDescription(description: string): boolean {
  if (description !== description.trim()) {
    return false;
  }
  return /^[\x20-\x7E]{10,350}$/.test(description);
}

/**
 * Validates a public key format
 * @param publicKey The public key string to validate
 * @returns True if the public key format is valid, false otherwise
 * @remarks
 * Valid public keys must:
 * - Start with "0x"
 * - Be followed by exactly 128 hexadecimal characters (0-9, a-f, A-F)
 * - Total length must be 130 characters (2 for "0x" + 128 hex characters)
 */
export function isValidPublicKey(publicKey: string): boolean {
  const publicKeyRegex = /^0x[0-9a-fA-F]{128}$/;
  return publicKeyRegex.test(publicKey);
}

/**
 * Validates if a string is a valid Flare Networks NodeID (Base58Check encoded)
 * @param {string} nodeID - The NodeID to validate
 * @returns {boolean} - True if the NodeID is valid, false otherwise
 */
export function isValidNodeID(nodeID: string): boolean {
  const nodeIdRegex = /^NodeID-[1-9A-HJ-NP-Za-km-z]{32,33}$/;
  return nodeIdRegex.test(nodeID);
}

/**
 * Validates if a NodeID hexstring is valid
 * @param {string} hexString - The hex string to validate
 * @returns {boolean} - True if the hex string is valid, false otherwise
 */
export function isValidNodeHex(hexString: string): boolean {
  const nodeIdRegex = /^0x[0-9a-f]{40}$/;
  return nodeIdRegex.test(hexString);
}

/**
 * Validates a logo image (provider WebP or dapp PNG) against size/dimension rules.
 *
 * Transparent backgrounds are recommended and accepted (WebP alpha, PNG RGBA).
 * Opaque logos, including a solid white background, stay valid. These checks
 * do not flatten alpha and do not require a background color.
 *
 * @param filePath Path to the image file
 * @param config Optional configuration to override default validation requirements
 * @returns Validation result with success status, any errors, and image metadata
 */
export function isValidImage(
  filePath: string,
  config?: {
    maxSizeKB?: number;
    minWidth?: number;
    maxWidth?: number;
    requireSquare?: boolean;
  },
): {
  isValid: boolean;
  errors: string[];
  metadata?: { width: number; height: number; sizeKB: number };
} {
  const errors: string[] = [];
  const metadata: { width: number; height: number; sizeKB: number } = {
    width: 0,
    height: 0,
    sizeKB: 0,
  };

  const maxSizeKB = config?.maxSizeKB ?? PROVIDER_LOGO_REQUIREMENTS.MAX_SIZE_KB;
  const minWidth = config?.minWidth ?? PROVIDER_LOGO_REQUIREMENTS.MIN_WIDTH;
  const maxWidth = config?.maxWidth ?? PROVIDER_LOGO_REQUIREMENTS.MAX_WIDTH;
  const requireSquare = config?.requireSquare ?? PROVIDER_LOGO_REQUIREMENTS.REQUIRE_SQUARE;

  try {
    if (!fs.existsSync(filePath)) {
      errors.push("File does not exist");
      return { isValid: false, errors };
    }

    const stats = fs.statSync(filePath);
    const fileSizeInKB = stats.size / 1024;
    metadata.sizeKB = fileSizeInKB;

    if (fileSizeInKB > maxSizeKB) {
      errors.push(`File exceeds maximum size: ${fileSizeInKB.toFixed(2)}KB (max: ${maxSizeKB}KB)`);
    }

    const fileBuffer = fs.readFileSync(filePath);

    const isPNG =
      fileBuffer[0] === 0x89 &&
      fileBuffer[1] === 0x50 &&
      fileBuffer[2] === 0x4e &&
      fileBuffer[3] === 0x47 &&
      fileBuffer[4] === 0x0d &&
      fileBuffer[5] === 0x0a &&
      fileBuffer[6] === 0x1a &&
      fileBuffer[7] === 0x0a;

    let width = 0;
    let height = 0;
    if (isWebpMagic(fileBuffer)) {
      const dims = readWebpDimensions(fileBuffer);
      if (!dims) {
        errors.push("Not a valid WebP file");
      } else {
        width = dims.width;
        height = dims.height;
      }
    } else if (isPNG) {
      width = fileBuffer.readUInt32BE(16);
      height = fileBuffer.readUInt32BE(20);
    } else {
      errors.push("Not a valid PNG or WebP file");
    }

    if (width > 0 && height > 0) {
      metadata.width = width;
      metadata.height = height;

      if (width < minWidth) {
        errors.push(`Width (${width}px) is less than minimum required (${minWidth}px)`);
      }

      if (width > maxWidth) {
        errors.push(`Width (${width}px) exceeds maximum allowed (${maxWidth}px)`);
      }

      if (requireSquare && height !== width) {
        errors.push(`Image is not square: ${width}x${height}`);
      }
    }
  } catch (error) {
    errors.push(
      `Error validating image: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
    metadata: errors.length === 0 ? metadata : undefined,
  };
}
