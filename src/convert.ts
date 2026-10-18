import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import bs58 from "bs58";
import { withAbsoluteLogoURL } from "./assetUrl.js";
import {
  ALLOWED_LINKS,
  BLOCKCHAIN_NETWORKS,
  DAPP_INFO_KEYS,
  type DappInfo,
  PROVIDER_INFO_KEYS,
  type ProviderInfo,
  SIGNED_PROVIDER_INFO_KEYS,
  type SupportedNetworks,
} from "./config.js";
import { type HexString, isValidNodeHex, isValidNodeID } from "./validate.js";

/**
 * Encodes a hex string directly to a NodeID string
 * @param hexString The hex string to encode
 * @returns The NodeID string
 */
export function encodeNodeID(hexString: HexString): string | "" {
  try {
    if (!isValidNodeHex(hexString)) {
      return "";
    }

    // Convert hex to buffer (remove '0x' prefix if present)
    const rawBuffer = Buffer.from(hexString.slice(2), "hex");

    // Calculate SHA-256 hash of the buffer
    const hash = crypto.createHash("sha256").update(rawBuffer).digest();

    // Get the last 4 bytes of the hash as the checksum
    const checksum = hash.subarray(-4);

    // Append the checksum to the original buffer
    const bufferWithChecksum = Buffer.concat([rawBuffer, checksum]);

    // Encode the result with Base58
    const encodedNodeId = bs58.encode(bufferWithChecksum);

    // Create the NodeID string
    return `NodeID-${encodedNodeId}`;
  } catch (_error) {
    // Return null if any error occurs during encoding
    return "";
  }
}

/**
 * Decodes a NodeID string back to its original hex string
 * @param nodeID The NodeID string to decode
 * @returns The original hex string or "0x" if invalid
 */
export function decodeNodeID(nodeID: string): HexString | "" {
  try {
    if (!isValidNodeID(nodeID)) {
      return "";
    }

    // Remove the "NodeID-" prefix
    const encodedPart = nodeID.slice(7);

    // Decode from Base58
    const bufferWithChecksum = bs58.decode(encodedPart);

    // The last 4 bytes are the checksum, so remove them
    const rawBuffer = bufferWithChecksum.slice(0, -4);

    // Convert to hex string and add 0x prefix
    return `0x${Buffer.from(rawBuffer).toString("hex")}` as HexString;
  } catch (_error) {
    // Return empty string if any error occurs during decoding
    return "";
  }
}

/**
 * Converts an absolute path to a path relative to the current working directory
 * @param absolutePath The absolute path to convert
 * @returns The path relative to the current working directory
 */
export function toRelativePath(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath);
}

/**
 * Sorts a provider info object according to the defined key order
 * @param providerInfo - The provider info object to sort
 * @returns A new sorted provider info object
 */
export function sortProviderInfo(providerInfo: Partial<ProviderInfo>): Partial<ProviderInfo> {
  // Create a new object with properties in the correct order
  const sortedInfo: Partial<ProviderInfo> = {};

  // Add properties in the order defined by PROVIDER_INFO_KEYS
  for (const key of PROVIDER_INFO_KEYS) {
    if (key in providerInfo) {
      if (key === "links" && providerInfo.links) {
        const sortedLinks: ProviderInfo["links"] = {};

        // Use the order defined in ALLOWED_LINKS
        for (const linkKey of ALLOWED_LINKS) {
          if (linkKey in providerInfo.links) {
            sortedLinks[linkKey as keyof typeof sortedLinks] =
              providerInfo.links[linkKey as keyof typeof providerInfo.links];
          }
        }

        sortedInfo.links = sortedLinks;
      } else if (key === "validators" && Array.isArray(providerInfo.validators)) {
        // Sort validators alphabetically
        sortedInfo.validators = [...providerInfo.validators].sort();
      } else {
        // @ts-expect-error - We know the key exists in providerInfo
        sortedInfo[key] = providerInfo[key];
      }
    }
  }

  return sortedInfo;
}

/**
 * Returns the provider-signed subset of an info object (sorted, curator fields excluded).
 * Signatures cover name, description, logo hash, website, links, identity, and
 * the responsibilities acknowledgement. Chain addresses and validators may change
 * without a new signature.
 */
export function signedProviderInfoPayload(
  providerInfo: Partial<ProviderInfo>,
): Partial<ProviderInfo> {
  const sorted = sortProviderInfo(providerInfo);
  const payload: Partial<ProviderInfo> = {};

  for (const key of SIGNED_PROVIDER_INFO_KEYS) {
    if (key in sorted) {
      // @ts-expect-error - key is a known ProviderInfo key
      payload[key] = sorted[key];
    }
  }

  return payload;
}

/**
 * Computes the message hash (0x-prefixed SHA-256) that providers sign for an info object
 */
export function providerInfoMessageHash(providerInfo: Partial<ProviderInfo>): string {
  const payload = signedProviderInfoPayload(providerInfo);
  return `0x${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

/**
 * Returns the version-controlled relative logo path for a provider
 */
export function providerLogoPath(networkPath: string, identityAddress: string): string {
  return `providers/${networkPath}/${identityAddress.toLowerCase()}/logo.webp`;
}

const require = createRequire(import.meta.url);

/**
 * JSON.stringify expands short arrays. Biome collapses them when they fit on one
 * line, and CI lints committed JSON, so catalog writers have to match that style.
 */
export function formatRepoJson(value: unknown, filePath: string): string {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  const biomeBin = require.resolve("@biomejs/biome/bin/biome");
  return execFileSync(process.execPath, [biomeBin, "format", "--stdin-file-path", filePath], {
    cwd: process.cwd(),
    input: json,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Writes {@link formatRepoJson} to disk. */
export function writeFormattedJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, formatRepoJson(value, filePath));
}

/**
 * Rebuilds data/providers/<chainPath>/all.json from every per-provider info.json.
 * Existing all.json order is kept. Providers not already in that file are appended,
 * so a new entrant stays at the bottom instead of being re-sorted by identity address.
 * @param chainPath Network directory name, e.g. "eip155-14"
 */
export function rebuildProvidersAllJson(chainPath: string): void {
  const chainDir = path.join(process.cwd(), "data", "providers", chainPath);
  if (!fs.existsSync(chainDir)) {
    return;
  }

  const providerDirs = fs
    .readdirSync(chainDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const byIdentity = new Map<string, ProviderInfo>();
  for (const dir of providerDirs) {
    const infoPath = path.join(chainDir, dir, "info.json");
    if (!fs.existsSync(infoPath)) {
      continue;
    }
    const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
    // info.json keeps relative logoURL; all.json is absolute for drop-in consumers
    byIdentity.set(
      info.identityAddress.toLowerCase(),
      withAbsoluteLogoURL(sortProviderInfo(info) as ProviderInfo),
    );
  }

  const allPath = path.join(chainDir, "all.json");
  const kept: string[] = [];
  const seen = new Set<string>();
  if (fs.existsSync(allPath)) {
    const previous = JSON.parse(fs.readFileSync(allPath, "utf8")) as ProviderInfo[];
    for (const provider of previous) {
      const identity = provider.identityAddress.toLowerCase();
      if (byIdentity.has(identity) && !seen.has(identity)) {
        kept.push(identity);
        seen.add(identity);
      }
    }
  }

  const appended = [...byIdentity.keys()]
    .filter((identity) => !seen.has(identity))
    .sort((a, b) => a.localeCompare(b));

  const providers = [...kept, ...appended].flatMap((identity) => {
    const provider = byIdentity.get(identity);
    return provider ? [provider] : [];
  });

  writeFormattedJson(allPath, providers);
}

/**
 * Rebuilds all.json for every provider chain directory
 */
export function rebuildAllProvidersAllJson(): void {
  const providersDir = path.join(process.cwd(), "data", "providers");
  if (!fs.existsSync(providersDir)) {
    return;
  }

  const chainDirs = fs
    .readdirSync(providersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const chainPath of chainDirs) {
    rebuildProvidersAllJson(chainPath);
  }
}

/**
 * Calculates the SHA256 hash of a file
 * @param filePath Path to the file to hash
 * @returns SHA256 hash as a hex string, or empty string if file doesn't exist
 */
export function calculateHash(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    console.info(`Warning: File not found at ${filePath}`);
    return "";
  }

  const fileContent = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(fileContent).digest("hex");
}

/**
 * Sorts a dapp info object according to the defined key order
 */
export function sortDappInfo(dappInfo: DappInfo): DappInfo {
  const sortedInfo = {} as DappInfo;

  for (const key of DAPP_INFO_KEYS) {
    if (key === "chains") {
      sortedInfo.chains = [...dappInfo.chains].sort();
    } else {
      sortedInfo[key] = dappInfo[key] as never;
    }
  }

  return sortedInfo;
}

/**
 * A dapp submission's signed payload and its 0x-prefixed SHA-256 hash.
 * MUST produce byte-identical output to apps/add and apps/intake: fixed key
 * order, chains sorted. Excludes logoURL (hosting detail, integrity is covered
 * by logoHash) and featured (curator-granted).
 */
export function dappSubmissionMessageHash(payload: {
  title: string;
  description: string;
  url: string;
  chains: string[];
  category: string;
  /** Empty string when category is not `other`. Bound in contentHash + EIP-712. */
  categoryOther: string;
  logoHash: string;
}): string {
  const canonical = {
    title: payload.title,
    description: payload.description,
    url: payload.url,
    chains: [...payload.chains].sort(),
    category: payload.category,
    categoryOther: payload.categoryOther,
    logoHash: payload.logoHash,
  };
  return `0x${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/**
 * Converts a network path (e.g. eip155-14) to CAIP-2 (e.g. eip155:14)
 */
export function networkPathToCaip2(networkPath: string): string {
  return networkPath.replace("-", ":");
}

/**
 * Returns the CAIP-2 chain id for a supported network key
 */
export function networkKeyToCaip2(networkKey: SupportedNetworks): string {
  return networkPathToCaip2(BLOCKCHAIN_NETWORKS[networkKey].path);
}

/**
 * Derives a filesystem slug from a dapp URL hostname (dots → hyphens)
 */
export function dappSlugFromUrl(url: string): string {
  const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  return hostname.replace(/\./g, "-");
}
