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

export const PROVIDER_VERIFICATION_INSTRUCTIONS =
  'To verify signatures, rebuild EIP-712 typed data (domain name "Bifrost Assets", version "1", chainId of the provider network, salt keccak256("https://bifrostwallet.com") when the signed info includes acknowledgedResponsibilities) with primary type ProviderListing from the provider\'s info.json without logoURL, listed, managementGroup, domainLinked, dualNetwork and firstTransaction: human-readable signed fields, linksJson and validatorsJson (JSON.stringify of the sorted links object and validators array), acknowledgedResponsibilities (bool) when present, and contentHash (bytes32 SHA-256 of that canonical signed JSON, including acknowledgedResponsibilities when present). Recover the signer via eth_signTypedData_v4. contentHash must equal messageHash in signatures.json.';

const PROVIDER_LISTING_FIELDS_BASE = [
  { name: "name", type: "string" },
  { name: "description", type: "string" },
  { name: "websiteURL", type: "string" },
  { name: "logoHash", type: "bytes32" },
  { name: "identityAddress", type: "address" },
  { name: "delegationAddress", type: "address" },
  { name: "signingPolicyAddress", type: "address" },
  { name: "submitAddress", type: "address" },
  { name: "submitSignaturesAddress", type: "address" },
  { name: "publicKey", type: "string" },
  { name: "linksJson", type: "string" },
  { name: "validatorsJson", type: "string" },
  { name: "contentHash", type: "bytes32" },
] as const;

export const PROVIDER_LISTING_TYPES = {
  ProviderListing: [
    { name: "name", type: "string" },
    { name: "description", type: "string" },
    { name: "websiteURL", type: "string" },
    { name: "logoHash", type: "bytes32" },
    { name: "identityAddress", type: "address" },
    { name: "delegationAddress", type: "address" },
    { name: "signingPolicyAddress", type: "address" },
    { name: "submitAddress", type: "address" },
    { name: "submitSignaturesAddress", type: "address" },
    { name: "publicKey", type: "string" },
    { name: "linksJson", type: "string" },
    { name: "validatorsJson", type: "string" },
    { name: "acknowledgedResponsibilities", type: "bool" },
    { name: "contentHash", type: "bytes32" },
  ],
} as const;

export const PROVIDER_LISTING_TYPES_LEGACY = {
  ProviderListing: [...PROVIDER_LISTING_FIELDS_BASE],
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
  delegationAddress: HexString;
  signingPolicyAddress: HexString;
  submitAddress: HexString;
  submitSignaturesAddress: HexString;
  publicKey: string;
  linksJson: string;
  validatorsJson: string;
  acknowledgedResponsibilities?: boolean;
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

export function providerListingUsesLegacyTypedData(info: Partial<ProviderInfo>): boolean {
  return info.acknowledgedResponsibilities === undefined;
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
  options?: { legacy?: boolean },
) {
  const legacy = options?.legacy ?? providerListingUsesLegacyTypedData(info);
  const payload = signedProviderInfoPayload(info);
  const links = (payload.links ?? {}) as Record<string, string>;
  const validators = (payload.validators ?? []) as string[];

  const baseMessage = {
    name: String(payload.name ?? ""),
    description: String(payload.description ?? ""),
    websiteURL: String(payload.websiteURL ?? ""),
    logoHash: asBytes32(String(payload.logoHash ?? "")),
    identityAddress: asAddress(String(payload.identityAddress ?? "")),
    delegationAddress: asAddress(String(payload.delegationAddress ?? "")),
    signingPolicyAddress: asAddress(String(payload.signingPolicyAddress ?? "")),
    submitAddress: asAddress(String(payload.submitAddress ?? "")),
    submitSignaturesAddress: asAddress(String(payload.submitSignaturesAddress ?? "")),
    publicKey: String(payload.publicKey ?? ""),
    linksJson: JSON.stringify(links),
    validatorsJson: JSON.stringify(validators),
    contentHash: asBytes32(contentHash),
  };

  if (legacy) {
    return {
      domain: {
        name: EIP712_DOMAIN_NAME,
        version: EIP712_DOMAIN_VERSION,
        chainId,
      },
      types: PROVIDER_LISTING_TYPES_LEGACY,
      primaryType: "ProviderListing" as const,
      message: baseMessage as ProviderListingMessage,
    };
  }

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
      ...baseMessage,
      acknowledgedResponsibilities: payload.acknowledgedResponsibilities === true,
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
