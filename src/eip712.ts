// EIP-712 typed data for listing signatures (eth_signTypedData_v4).
// Must stay in sync with assets-intake apps/add + apps/intake eip712 modules.

import { keccak256, toBytes } from "viem";
import type { ProviderInfo } from "./config.js";
import {
  dappSubmissionMessageHash,
  providerInfoMessageHash,
  signedProviderInfoPayload,
} from "./convert.js";
import type { HexString } from "./validate.js";

export const EIP712_DOMAIN_NAME = "Bifrost Assets";
export const EIP712_DOMAIN_VERSION = "1";

/** Portal origin bound into the domain separator (bytes32). */
export const EIP712_DOMAIN_SALT = keccak256(toBytes("https://bifrostwallet.com"));

/** Fixed domain chain for dapp listings (Bifrost / Flare ecosystem portal). */
export const DAPP_EIP712_CHAIN_ID = 14;

export const PROVIDER_VERIFICATION_INSTRUCTIONS = [
  "To verify, recover the signer with eth_signTypedData_v4.",
  'Domain: name "Bifrost Assets", version "1", chainId of the provider network, and salt keccak256 of the UTF-8 string "https://bifrostwallet.com".',
  "primaryType: ProviderListing.",
  "Fields in order: name (string), description (string), websiteURL (string), logoHash (bytes32), identityAddress (address), linksJson (string), acknowledgedResponsibilities (bool), contentHash (bytes32).",
  "logoHash is the SHA-256 of logo.webp as 64 lowercase hex characters; the typed-data field is that digest with a 0x prefix.",
  "messageHash in signatures.json and contentHash are 0x plus the SHA-256 of JSON.stringify of an object whose keys, in order, are name, description, logoHash (that unprefixed hex), websiteURL, links, identityAddress, and acknowledgedResponsibilities.",
  "links includes only the keys that are set, in order github, x, discord, telegram, youtube, reddit, linkedin, tiktok.",
  "linksJson is JSON.stringify of that links object.",
  "contentHash must equal messageHash.",
  "Anything not listed is not signed and can change without a new signature.",
].join(" ");

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

export const DAPP_LISTING_TYPES = {
  DappListing: [
    { name: "title", type: "string" },
    { name: "description", type: "string" },
    { name: "url", type: "string" },
    { name: "chainsJson", type: "string" },
    { name: "category", type: "string" },
    { name: "categoryOther", type: "string" },
    { name: "logoHash", type: "bytes32" },
    { name: "contentHash", type: "bytes32" },
  ],
} as const;

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

export type DappListingMessage = {
  title: string;
  description: string;
  url: string;
  chainsJson: string;
  category: string;
  categoryOther: string;
  logoHash: HexString;
  contentHash: HexString;
};

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

  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId,
      salt: EIP712_DOMAIN_SALT,
    },
    types: PROVIDER_LISTING_TYPES,
    primaryType: "ProviderListing" as const,
    message: {
      name: String(payload.name ?? ""),
      description: String(payload.description ?? ""),
      websiteURL: String(payload.websiteURL ?? ""),
      logoHash: asBytes32(String(payload.logoHash ?? "")),
      identityAddress: asAddress(String(payload.identityAddress ?? "")),
      linksJson: JSON.stringify(links),
      acknowledgedResponsibilities: payload.acknowledgedResponsibilities === true,
      contentHash: asBytes32(contentHash),
    } satisfies ProviderListingMessage,
  };
}

export function providerListingTypedData(info: Partial<ProviderInfo>, chainId: number) {
  const contentHash = providerInfoMessageHash(info);
  return { ...buildProviderListingTypedData(info, chainId, contentHash), contentHash };
}

export function dappListingTypedData(payload: {
  title: string;
  description: string;
  url: string;
  chains: string[];
  category: string;
  categoryOther: string;
  logoHash: string;
}) {
  const contentHash = dappSubmissionMessageHash(payload);
  const chains = [...payload.chains].sort();
  const message: DappListingMessage = {
    title: payload.title,
    description: payload.description,
    url: payload.url,
    chainsJson: JSON.stringify(chains),
    category: payload.category,
    categoryOther: payload.categoryOther,
    logoHash: asBytes32(payload.logoHash),
    contentHash: asBytes32(contentHash),
  };
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: DAPP_EIP712_CHAIN_ID,
    },
    types: DAPP_LISTING_TYPES,
    primaryType: "DappListing" as const,
    message,
    contentHash,
  };
}
