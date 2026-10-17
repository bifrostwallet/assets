import * as fs from "node:fs";
import * as path from "node:path";
import { getAssetBaseURL, withAbsoluteLogoURL } from "../assetUrl.js";
import type { ProviderInfo } from "../config.js";
import { type ContractInfo, listContractChainPaths } from "../contracts.js";
import { isMain } from "../isMain.js";
import { rollupChainHashes, sha256Hex } from "../manifest.js";
import { listTokenChainPaths, type TokenInfo } from "../tokens.js";

// Builds the publishable @bifrostwallet/assets NPM package into dist/.
//
// The published artifact is ZERO-DEPENDENCY by design: JSON data plus small pure
// CommonJS helpers and TypeScript declarations. All tooling (viem, GCS)
// stays in this repository's devDependencies and is never shipped.
//
// Logos are NOT bundled. Published JSON uses absolute logoURL (GitHub raw by
// default). Operators set ASSET_BASE_URL to publish against their own CDN host.
//
// Publish with: yarn build:package && npm publish ./dist

const PROVIDER_CHAINS = ["eip155-14", "eip155-19"] as const;

function loadProviders(chainPath: string): ProviderInfo[] {
  const allPath = path.join(process.cwd(), "data", "providers", chainPath, "all.json");
  const providers = JSON.parse(fs.readFileSync(allPath, "utf8")) as ProviderInfo[];
  const base = getAssetBaseURL();
  return providers.map((provider) => withAbsoluteLogoURL(provider, base));
}

function loadTokens(chainPath: string): TokenInfo[] {
  const allPath = path.join(process.cwd(), "data", "tokens", chainPath, "all.json");
  const tokens = JSON.parse(fs.readFileSync(allPath, "utf8")) as TokenInfo[];
  const base = getAssetBaseURL();
  return tokens.map((token) => withAbsoluteLogoURL(token, base));
}

function loadContracts(chainPath: string): ContractInfo[] {
  const allPath = path.join(process.cwd(), "data", "contracts", chainPath, "all.json");
  const contracts = JSON.parse(fs.readFileSync(allPath, "utf8")) as ContractInfo[];
  const base = getAssetBaseURL();
  return contracts.map((contract) => {
    if (!contract.logoURL) return contract;
    return withAbsoluteLogoURL({ ...contract, logoURL: contract.logoURL }, base);
  });
}

function loadManifestPublicKey(): string {
  const pemPath = path.join(process.cwd(), "manifest-public.pem");
  if (!fs.existsSync(pemPath)) {
    console.warn("⚠️  manifest-public.pem missing — run ./yarn manifest:generate-key");
    return "";
  }
  return fs.readFileSync(pemPath, "utf8").trim();
}

function buildIndexJs(
  sectionHashesJson: string,
  publicKeyPem: string,
  tokenChains: string[],
  contractChains: string[],
): string {
  const publicKeyLiteral = JSON.stringify(publicKeyPem);
  const tokenRequires =
    tokenChains.length === 0
      ? ""
      : `${tokenChains.map((chain) => `  "${chain}": require("./tokens/${chain}.json"),`).join("\n")}\n`;
  const blocklistRequire =
    tokenChains.length > 0 ? 'require("./tokens/blocklist.json")' : "{ tokens: [] }";
  const contractRequires =
    contractChains.length === 0
      ? ""
      : `${contractChains.map((chain) => `  "${chain}": require("./contracts/${chain}.json"),`).join("\n")}\n`;
  return `"use strict";
// @bifrostwallet/assets — generated file, do not edit.

const providersByChain = {
${PROVIDER_CHAINS.map((chain) => `  "${chain}": require("./providers/${chain}.json"),`).join("\n")}
};

const tokensByChain = {
${tokenRequires}};

const tokenBlocklist = ${blocklistRequire};

const contractsByChain = {
${contractRequires}};

/** Bundled snapshot of section content hashes (same algorithm as CDN manifest.json). */
const SECTION_HASHES = ${sectionHashesJson};

/**
 * Ed25519 SPKI public key (PEM) used to verify CDN manifest.json signatures.
 * Verify with node:crypto (Node) or Web Crypto Ed25519 (browsers).
 */
const MANIFEST_PUBLIC_KEY = ${publicKeyLiteral};

const DEFAULT_ASSET_BASE_URL = ${JSON.stringify(getAssetBaseURL())};

const PROVIDER_CHAIN_IDS = Object.keys(providersByChain).map(chainPathToCaip2);
const TOKEN_CHAIN_IDS = Object.keys(tokensByChain).map(chainPathToCaip2);
const CONTRACT_CHAIN_IDS = Object.keys(contractsByChain).map(chainPathToCaip2);

function chainPathToCaip2(chainPath) {
  const i = String(chainPath).indexOf("-");
  return i === -1 ? String(chainPath) : String(chainPath).slice(0, i) + ":" + String(chainPath).slice(i + 1);
}

function normalizeChainId(chainId) {
  // Public API accepts CAIP-2 only (e.g. "eip155:14"). Repo paths use eip155-14.
  if (typeof chainId !== "string" || !chainId.includes(":")) {
    throw new Error(
      'Use a CAIP-2 chain id (e.g. "eip155:14"). Got: ' + JSON.stringify(chainId)
    );
  }
  return chainId.replace(":", "-");
}

function getProviders(chainId) {
  const providers = providersByChain[normalizeChainId(chainId)];
  if (!providers) {
    throw new Error(
      "Unknown chain " + chainId + ". Available: " + PROVIDER_CHAIN_IDS.join(", ")
    );
  }
  return providers;
}

function getProvider(chainId, identityAddress) {
  const target = String(identityAddress).toLowerCase();
  return (
    getProviders(chainId).find(
      (provider) => provider.identityAddress.toLowerCase() === target
    ) ?? null
  );
}

function getListedProviders(chainId) {
  return getProviders(chainId).filter((provider) => provider.listed);
}

function getManagementGroupProviders(chainId) {
  return getProviders(chainId).filter((provider) => provider.managementGroup);
}

function findProviderByValidator(chainId, nodeId) {
  return (
    getProviders(chainId).find((provider) => provider.validators.includes(nodeId)) ??
    null
  );
}

function getTokens(chainId) {
  const tokens = tokensByChain[normalizeChainId(chainId)];
  if (!tokens) {
    throw new Error(
      "Unknown token chain " + chainId + ". Available: " + TOKEN_CHAIN_IDS.join(", ")
    );
  }
  return tokens;
}

function getToken(chainId, address) {
  const target = String(address).toLowerCase();
  return (
    getTokens(chainId).find(
      (token) => token.address && token.address.toLowerCase() === target
    ) ?? null
  );
}

function getNativeToken(chainId) {
  return getTokens(chainId).find((token) => token.address === null) ?? null;
}

function getTokenBlocklist() {
  return tokenBlocklist.tokens || [];
}

function getContracts(chainId) {
  if (chainId == null) {
    const all = [];
    for (const chain of Object.keys(contractsByChain).sort()) {
      all.push(...contractsByChain[chain]);
    }
    return all;
  }
  const contracts = contractsByChain[normalizeChainId(chainId)];
  if (!contracts) {
    throw new Error(
      "Unknown contract chain " + chainId + ". Available: " + CONTRACT_CHAIN_IDS.join(", ")
    );
  }
  return contracts;
}

function getContract(chainId, address) {
  const target = String(address).toLowerCase();
  return (
    getContracts(chainId).find((contract) => contract.address.toLowerCase() === target) ?? null
  );
}

function resolveAssetURL(relativePath, baseURL) {
  const base = baseURL || DEFAULT_ASSET_BASE_URL;
  return base.replace(/\\/?$/, "/") + String(relativePath).replace(/^\\//, "");
}

function getSectionHashes() {
  return SECTION_HASHES;
}

const SECTION_ORDER = ["providers", "contracts", "dapps", "tokens"];

/** Canonical UTF-8 JSON bytes (as string) that the Ed25519 signature covers. */
function canonicalManifestBody(body) {
  const sections = {};
  for (const name of SECTION_ORDER) {
    const section = body.sections[name];
    if (!section) continue;
    const entry = { contentHash: section.contentHash };
    if (section.chains) {
      const chains = {};
      for (const chain of Object.keys(section.chains).sort()) {
        chains[chain] = section.chains[chain];
      }
      entry.chains = chains;
    }
    sections[name] = entry;
  }
  return JSON.stringify({ generatedAt: body.generatedAt, sections });
}

/**
 * Verify CDN manifest.json with node:crypto Ed25519 (Node / bundlers that polyfill it).
 * Browsers: Web Crypto Ed25519 over Buffer.from(canonicalManifestBody(body), "utf8").
 */
function verifyManifest(manifest, publicKeyPem) {
  const { createPublicKey, verify } = require("node:crypto");
  const { signature, ...body } = manifest;
  const message = Buffer.from(canonicalManifestBody(body), "utf8");
  return verify(
    null,
    message,
    createPublicKey(publicKeyPem || MANIFEST_PUBLIC_KEY),
    Buffer.from(signature, "base64url")
  );
}

module.exports = {
  DEFAULT_ASSET_BASE_URL,
  PROVIDER_CHAIN_IDS,
  TOKEN_CHAIN_IDS,
  CONTRACT_CHAIN_IDS,
  MANIFEST_PUBLIC_KEY,
  getSectionHashes,
  canonicalManifestBody,
  verifyManifest,
  getProviders,
  getProvider,
  getListedProviders,
  getManagementGroupProviders,
  findProviderByValidator,
  getTokens,
  getToken,
  getNativeToken,
  getTokenBlocklist,
  getContracts,
  getContract,
  resolveAssetURL,
};
`;
}

const INDEX_DTS = `// @bifrostwallet/assets — generated file, do not edit.

export interface ProviderInfo {
  name: string;
  description: string;
  websiteURL: string;
  links: {
    github?: string;
    x?: string;
    discord?: string;
    telegram?: string;
    youtube?: string;
    reddit?: string;
    linkedin?: string;
    tiktok?: string;
  };
  /**
   * Absolute logo URL in published lists (GitHub raw by default).
   * info.json in git keeps a relative path; resolveAssetURL() still works for either form.
   */
  logoURL: string;
  /** SHA-256 of the logo file, covered by provider signatures */
  logoHash: string;
  identityAddress: string;
  delegationAddress: string;
  signingPolicyAddress: string;
  submitAddress: string;
  submitSignaturesAddress: string;
  publicKey: string;
  /** Avalanche-style NodeIDs of the provider's validators */
  validators: string[];
  /** Curator-granted listing flag for Bifrost Wallet UIs */
  listed: boolean;
  /** Flare FTSO Management Group membership (synced on-chain) */
  managementGroup: boolean;
  /** Optional domain linkage, refreshed nightly from websiteURL */
  domainLinked: boolean;
  /** Same brand present on both Flare and Songbird in this catalog (curator-reviewed) */
  dualNetwork: boolean;
  /** Earliest known provider activity on this network (write-once, curator-managed) */
  firstTransaction?: {
    hash: string;
    blockNumber: number;
    /** ISO 8601 UTC */
    timestamp: string;
  };
}

export interface TokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  /** Lowercase 0x… for contracts; null for the chain native gas token */
  address: string | null;
  /** Always present — string CoinGecko id, or null when unmapped / unpriced */
  coingeckoId: string | null;
  logoURL: string;
  logoHash: string;
}

export interface TokenBlocklistEntry {
  chainPath: string;
  address: string;
  identifier: string;
}

export interface ManifestSectionHashes {
  contentHash: string;
  chains?: Record<string, string>;
}

/** CAIP-2 chain id, e.g. "eip155:14" or "eip155:19" */
export type ChainId = string;

export declare const DEFAULT_ASSET_BASE_URL: string;
export declare const PROVIDER_CHAIN_IDS: string[];
export declare const TOKEN_CHAIN_IDS: string[];
export declare const CONTRACT_CHAIN_IDS: string[];

export type ContractCategory =
  | "aggregator"
  | "router"
  | "collateral-pool"
  | "agent-vault"
  | "staking-protocol"
  | "bridge"
  | "dapp-contract";

export interface ContractInfo {
  /** Lowercase 0x address */
  address: string;
  /** CAIP-2 chain id, e.g. "eip155:14" */
  chain: string;
  projectName: string;
  contractName: string;
  category: ContractCategory;
  /** Absolute logo URL when the contract has one */
  logoURL?: string;
}
/** Ed25519 SPKI PEM for verifying CDN manifest.json (empty string if key not generated yet) */
export declare const MANIFEST_PUBLIC_KEY: string;

/** Section content hashes baked into this package release (compare to CDN manifest) */
export declare function getSectionHashes(): {
  providers?: ManifestSectionHashes;
  contracts?: ManifestSectionHashes;
  dapps?: ManifestSectionHashes;
  tokens?: ManifestSectionHashes;
};

export interface AssetsManifestBody {
  generatedAt: string;
  sections: {
    providers?: ManifestSectionHashes;
    contracts?: ManifestSectionHashes;
    dapps?: ManifestSectionHashes;
    tokens?: ManifestSectionHashes;
  };
}

export interface AssetsManifest extends AssetsManifestBody {
  signature: string;
}

/** Canonical JSON string signed by the Bifrost Ed25519 publish key */
export declare function canonicalManifestBody(body: AssetsManifestBody): string;
/**
 * Verify CDN manifest with node:crypto Ed25519.
 * Defaults to MANIFEST_PUBLIC_KEY when publicKeyPem is omitted.
 */
export declare function verifyManifest(
  manifest: AssetsManifest,
  publicKeyPem?: string
): boolean;

/** All curated providers for a chain (throws on unknown chain) */
export declare function getProviders(chainId: ChainId): ProviderInfo[];
/** A single provider by identity address (case-insensitive), or null */
export declare function getProvider(
  chainId: ChainId,
  identityAddress: string
): ProviderInfo | null;
/** Providers listed in Bifrost Wallet UIs */
export declare function getListedProviders(chainId: ChainId): ProviderInfo[];
/** Providers that are current FTSO Management Group members */
export declare function getManagementGroupProviders(chainId: ChainId): ProviderInfo[];
/** The provider operating a validator NodeID, or null */
export declare function findProviderByValidator(
  chainId: ChainId,
  nodeId: string
): ProviderInfo | null;
/** All curated tokens for a chain (throws on unknown chain) */
export declare function getTokens(chainId: ChainId): TokenInfo[];
/** A single ERC-20 by address (case-insensitive), or null */
export declare function getToken(chainId: ChainId, address: string): TokenInfo | null;
/** Native gas token entry for a chain, or null */
export declare function getNativeToken(chainId: ChainId): TokenInfo | null;
/** Curated token blocklist entries */
export declare function getTokenBlocklist(): TokenBlocklistEntry[];
/**
 * Curated contracts. Omit chainId for every chain.
 * Throws on an unknown CAIP-2 id.
 */
export declare function getContracts(chainId?: ChainId): ContractInfo[];
/** One contract by address (case-insensitive), or null */
export declare function getContract(chainId: ChainId, address: string): ContractInfo | null;
/**
 * Joins a relative (or already-absolute) asset path to a base URL.
 * Defaults to the base baked into this package build (ASSET_BASE_URL / GitHub raw).
 */
export declare function resolveAssetURL(relativePath: string, baseURL?: string): string;
`;

function buildPackage(): void {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const assetBase = getAssetBaseURL();

  const distDir = path.join(process.cwd(), "dist");
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(distDir, "providers"), { recursive: true });

  const providerChains: Record<string, string> = {};
  for (const chain of PROVIDER_CHAINS) {
    const providers = loadProviders(chain);
    const outPath = path.join(distDir, "providers", `${chain}.json`);
    const body = `${JSON.stringify(providers, null, 2)}\n`;
    fs.writeFileSync(outPath, body);
    providerChains[chain] = sha256Hex(body);
    console.info(`📦 providers/${chain}.json (${providers.length} providers)`);
  }

  const tokenChainIds = listTokenChainPaths();
  const tokenChains: Record<string, string> = {};
  if (tokenChainIds.length > 0) {
    fs.mkdirSync(path.join(distDir, "tokens"), { recursive: true });
    for (const chain of tokenChainIds) {
      const tokens = loadTokens(chain);
      const outPath = path.join(distDir, "tokens", `${chain}.json`);
      const body = `${JSON.stringify(tokens, null, 2)}\n`;
      fs.writeFileSync(outPath, body);
      tokenChains[chain] = sha256Hex(body);
      console.info(`📦 tokens/${chain}.json (${tokens.length} tokens)`);
    }
    const blocklistSrc = path.join(process.cwd(), "data", "tokens", "blocklist.json");
    if (fs.existsSync(blocklistSrc)) {
      const blockBody = fs.readFileSync(blocklistSrc);
      fs.writeFileSync(path.join(distDir, "tokens", "blocklist.json"), blockBody);
      tokenChains.blocklist = sha256Hex(blockBody);
      console.info("📦 tokens/blocklist.json");
    }
  }

  const contractChainIds = listContractChainPaths();
  const contractChains: Record<string, string> = {};
  if (contractChainIds.length > 0) {
    fs.mkdirSync(path.join(distDir, "contracts"), { recursive: true });
    for (const chain of contractChainIds) {
      const contracts = loadContracts(chain);
      const outPath = path.join(distDir, "contracts", `${chain}.json`);
      const body = `${JSON.stringify(contracts, null, 2)}\n`;
      fs.writeFileSync(outPath, body);
      contractChains[chain] = sha256Hex(body);
      console.info(`📦 contracts/${chain}.json (${contracts.length} contracts)`);
    }
  }

  const sections: {
    providers: { contentHash: string; chains: Record<string, string> };
    contracts?: { contentHash: string; chains: Record<string, string> };
    tokens?: { contentHash: string; chains: Record<string, string> };
  } = {
    providers: {
      contentHash: rollupChainHashes(providerChains),
      chains: providerChains,
    },
  };
  if (Object.keys(contractChains).length > 0) {
    sections.contracts = {
      contentHash: rollupChainHashes(contractChains),
      chains: contractChains,
    };
  }
  if (Object.keys(tokenChains).length > 0) {
    sections.tokens = {
      contentHash: rollupChainHashes(tokenChains),
      chains: tokenChains,
    };
  }
  const sectionHashesJson = JSON.stringify(sections, null, 2);
  const publicKeyPem = loadManifestPublicKey();
  console.info(`🖼️  logoURL base: ${assetBase}`);

  fs.writeFileSync(
    path.join(distDir, "index.js"),
    buildIndexJs(sectionHashesJson, publicKeyPem, tokenChainIds, contractChainIds),
  );
  fs.writeFileSync(path.join(distDir, "index.d.ts"), INDEX_DTS);
  fs.writeFileSync(path.join(distDir, "section-hashes.json"), `${sectionHashesJson}\n`);

  const manifest = {
    name: "@bifrostwallet/assets",
    version: rootPackage.version,
    description: rootPackage.description ?? "Curated assets for Bifrost Wallet.",
    repository: rootPackage.repository,
    author: rootPackage.author,
    license: "MIT",
    main: "index.js",
    types: "index.d.ts",
    sideEffects: false,
    dependencies: {},
  };
  fs.writeFileSync(path.join(distDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const packageReadmePath = path.join(process.cwd(), "package", "README.md");
  if (!fs.existsSync(packageReadmePath)) {
    throw new Error("package/README.md missing — required for the published npm README");
  }
  fs.copyFileSync(packageReadmePath, path.join(distDir, "README.md"));

  const written = JSON.parse(fs.readFileSync(path.join(distDir, "package.json"), "utf8"));
  const dependencyCount = Object.keys(written.dependencies ?? {}).length;
  if (dependencyCount > 0 || written.devDependencies || written.peerDependencies) {
    throw new Error("dist/package.json must not declare any dependencies");
  }

  console.info("\n✅ Built zero-dependency package in dist/");
  console.info("   Publish with: npm publish ./dist");
}

if (isMain(import.meta.url)) {
  try {
    buildPackage();
  } catch (error) {
    console.error("❌ Package build failed:", error);
    process.exitCode = 1;
  }
}

export default buildPackage;
