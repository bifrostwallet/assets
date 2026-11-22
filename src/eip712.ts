// EIP-712 typed data for listing signatures (eth_signTypedData_v4).
// Must stay in sync with the listing form and intake service.
//
// Two versions, selected by a signatures.json entry's `version` field:
// - 1 (no field): the listing fields. The entry's date is not signed.
// - 2: the listing fields plus signedAt (the entry's date), nonce and sealedHash.
//   Listing submissions must use version 2; version 1 entries stay verifiable.
// The package's main entry keeps exporting the version 1 constants unchanged.
// The package build copies these constants into the package entry and the signatures entry.
// The salt is precomputed so verifiers do not hash it or take a hashing dependency.

import type { ProviderInfo } from "./config.js";
import { providerInfoMessageHash, signedProviderInfoPayload } from "./convert.js";
import type { HexString } from "./validate.js";

export const EIP712_DOMAIN_NAME = "Bifrost Assets";
export const EIP712_DOMAIN_VERSION = "1";
export const EIP712_DOMAIN_VERSION_2 = "2";
/** signatures.json entry `version` for version 2 typed data. */
export const PROVIDER_SIGNATURE_VERSION_2 = 2;

const LISTING_CHAIN_IDS = {
  "eip155:14": 14,
  "eip155:19": 19,
} as const;

export type ProviderListingChain = keyof typeof LISTING_CHAIN_IDS;

/**
 * keccak256 of the UTF-8 bytes of https://bifrostwallet.com.
 * Stored as bytes32 so callers do not hash it at runtime.
 */
export const EIP712_DOMAIN_SALT =
  "0xffc5336f20c2026b0f53d269def3cdffa3ca99b07e238af05f263a89517104f7" as const;

export const PROVIDER_VERIFICATION_INSTRUCTIONS = [
  "To verify, recover the signer with eth_signTypedData_v4.",
  "An entry's version field selects the typed data; an entry without it is version 1.",
  'Domain: name "Bifrost Assets", version "1" or "2" to match the entry, chainId of the provider network, and salt keccak256 of the UTF-8 string "https://bifrostwallet.com".',
  "primaryType: ProviderListing.",
  "Version 1 fields in order: name (string), description (string), websiteURL (string), logoHash (bytes32), identityAddress (address), linksJson (string), acknowledgedResponsibilities (bool), contentHash (bytes32).",
  "Version 2 fields are the version 1 fields followed by signedAt (string), nonce (string), sealedHash (bytes32), taken from the entry's date, nonce and sealedHash.",
  "logoHash is the SHA-256 of logo.webp as 64 lowercase hex characters; the typed-data field is that digest with a 0x prefix.",
  "messageHash in signatures.json and contentHash are 0x plus the SHA-256 of JSON.stringify of an object whose keys, in order, are name, description, logoHash (that unprefixed hex), websiteURL, links, identityAddress, and acknowledgedResponsibilities.",
  "links includes only the keys that are set, in order github, x, discord, telegram, youtube, reddit, linkedin, tiktok.",
  "linksJson is JSON.stringify of that links object.",
  "contentHash must equal messageHash.",
  "Anything not listed is not signed and can change without a new signature.",
].join(" ");

export const PROVIDER_LISTING_PRIMARY_TYPE = "ProviderListing" as const;

export const PROVIDER_LISTING_TYPES = {
  ProviderListing: [
    { name: "name", type: "string" },
    { name: "description", type: "string" },
    { name: "websiteURL", type: "string" },
    { name: "logoHash", type: "bytes32" },
    { name: "identityAddress", type: "address" },
    { name: "linksJson", type: "string" },
    { name: "acknowledgedResponsibilities", type: "bool" },
    { name: "contentHash", type: "bytes32" },
  ],
} as const;

export const PROVIDER_LISTING_V2_TYPES = {
  ProviderListing: [
    ...PROVIDER_LISTING_TYPES.ProviderListing,
    { name: "signedAt", type: "string" },
    { name: "nonce", type: "string" },
    { name: "sealedHash", type: "bytes32" },
  ],
} as const;

/** The version 2 fields that come from the signature entry, not from info.json. */
export type ListingSignatureFields = {
  /** The entry's date (UTC ISO-8601). */
  signedAt: string;
  nonce: string;
  sealedHash: string;
};

export type ProviderListingMessage = {
  name: string;
  description: string;
  websiteURL: string;
  logoHash: HexString;
  identityAddress: HexString;
  linksJson: string;
  acknowledgedResponsibilities: boolean;
  contentHash: HexString;
};

export function listingChainId(chain: string): number {
  if (!Object.hasOwn(LISTING_CHAIN_IDS, chain)) {
    throw new Error(`Use "eip155:14" or "eip155:19". Got: ${JSON.stringify(chain)}`);
  }
  return LISTING_CHAIN_IDS[chain as ProviderListingChain];
}

function chainFromChainId(chainId: number): ProviderListingChain {
  const chain = `eip155:${chainId}`;
  if (!Object.hasOwn(LISTING_CHAIN_IDS, chain)) {
    throw new Error(`Unsupported provider chain id: ${chainId}`);
  }
  return chain as ProviderListingChain;
}

/** Typed data for recoverTypedDataAddress({ ...typedData, signature }) and verifyTypedData. */
export function providerListingTypedData<const T extends ProviderListingMessage>(options: {
  message: T;
  chain: ProviderListingChain;
}) {
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: listingChainId(options.chain),
      salt: EIP712_DOMAIN_SALT,
    },
    types: PROVIDER_LISTING_TYPES,
    primaryType: PROVIDER_LISTING_PRIMARY_TYPE,
    message: options.message,
  };
}

function asBytes32(hash: string): HexString {
  const raw = hash.startsWith("0x") || hash.startsWith("0X") ? hash.slice(2) : hash;
  const normalized = raw.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Invalid bytes32 hash: ${hash}`);
  }
  return `0x${normalized}`;
}

function asAddress(value: string): HexString {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`Invalid address: ${value}`);
  }
  return normalized as HexString;
}

/** Parse eip155-<id> directory name (or full provider dir) to chainId. */
export function chainIdFromProviderPath(providerDirOrChainPath: string): number {
  const base = providerDirOrChainPath.replace(/\\/g, "/");
  const parts = base.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const match = parts[i].match(/^eip155-(\d+)$/);
    if (match) return Number(match[1]);
  }
  throw new Error(`Could not determine chainId from path: ${providerDirOrChainPath}`);
}

export function buildProviderListingTypedData(
  info: Partial<ProviderInfo>,
  chainId: number,
  contentHash: string,
) {
  const payload = signedProviderInfoPayload(info);
  const links = (payload.links ?? {}) as Record<string, string>;

  return providerListingTypedData({
    chain: chainFromChainId(chainId),
    message: {
      name: String(payload.name ?? ""),
      description: String(payload.description ?? ""),
      websiteURL: String(payload.websiteURL ?? ""),
      logoHash: asBytes32(String(payload.logoHash ?? "")),
      identityAddress: asAddress(String(payload.identityAddress ?? "")),
      linksJson: JSON.stringify(links),
      acknowledgedResponsibilities: payload.acknowledgedResponsibilities === true,
      contentHash: asBytes32(contentHash),
    },
  });
}

export function providerListingTypedDataFromInfo(info: Partial<ProviderInfo>, chainId: number) {
  const contentHash = providerInfoMessageHash(info);
  return { ...buildProviderListingTypedData(info, chainId, contentHash), contentHash };
}

/** Version 2 typed data: the version 1 message plus the entry's signed fields. */
export function providerListingV2TypedDataFromInfo(
  info: Partial<ProviderInfo>,
  chainId: number,
  fields: ListingSignatureFields,
) {
  const v1 = providerListingTypedDataFromInfo(info, chainId);
  return {
    domain: { ...v1.domain, version: EIP712_DOMAIN_VERSION_2 },
    types: PROVIDER_LISTING_V2_TYPES,
    primaryType: PROVIDER_LISTING_PRIMARY_TYPE,
    message: {
      ...v1.message,
      signedAt: fields.signedAt,
      nonce: fields.nonce,
      sealedHash: asBytes32(fields.sealedHash),
    },
    contentHash: v1.contentHash,
  };
}

/** The signature-entry fields that select and complete the typed data. */
export type SignatureEntryVersionFields = {
  date: string;
  version?: unknown;
  nonce?: unknown;
  sealedHash?: unknown;
};

/**
 * Typed data a signatures.json entry was signed over: version 1 when the entry
 * has no `version`, version 2 when it is 2. Throws for anything else or for a
 * version 2 entry without its signed fields.
 */
export function providerListingTypedDataForEntry(
  info: Partial<ProviderInfo>,
  chainId: number,
  entry: SignatureEntryVersionFields,
) {
  if (entry.version === undefined) return providerListingTypedDataFromInfo(info, chainId);
  if (entry.version !== PROVIDER_SIGNATURE_VERSION_2) {
    throw new Error(`Unsupported signature version: ${JSON.stringify(entry.version)}`);
  }
  if (typeof entry.nonce !== "string" || entry.nonce === "") {
    throw new Error("Version 2 signature is missing its nonce");
  }
  if (typeof entry.sealedHash !== "string") {
    throw new Error("Version 2 signature is missing its sealedHash");
  }
  return providerListingV2TypedDataFromInfo(info, chainId, {
    signedAt: entry.date,
    nonce: entry.nonce,
    sealedHash: entry.sealedHash,
  });
}
