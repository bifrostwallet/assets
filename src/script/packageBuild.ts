import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { withRelativeLogoURL } from "../assetUrl.js";
import { DAPP_CATEGORIES, DAPP_CATEGORY_LABELS, type ProviderInfo } from "../config.js";
import {
  CONTRACT_CATEGORIES,
  CONTRACT_CATEGORY_LABELS,
  type ContractInfo,
  chainPathToCaip2,
  getContracts,
  listContractChainPaths,
  validateContractCatalog,
} from "../contracts.js";
import { isMain } from "../isMain.js";
import { releaseTagForVersion } from "../releaseTag.js";
import { type EvmToken, listTokenChainPaths } from "../tokens.js";
import type { XrplToken } from "../xrplToken.js";

// Builds the publishable @bifrostwallet/assets NPM package into dist/.
//
// The published artifact is ZERO-DEPENDENCY by design: JSON data plus small pure
// CommonJS helpers and TypeScript declarations. All tooling (viem, GCS)
// stays in this repository's devDependencies and is never shipped.
//
// Published JSON keeps logoURL relative (providers/…, tokens/…, dapps/…, contracts/…).
// Provider and token all.json in git are absolute GitHub URLs; withRelativeLogoURL
// strips them, including token entries. Logo files are not bundled; they stay in git.
// Contract source JSON stores a project slug. This build denormalizes projectName, logoURL, and logoHash onto
// each published contract. createAssets({ baseURL }) is the only public entry. It
// resolves asset paths per call and does not mutate the shared records. There is
// no default base. Provider signatures ship as a separate entry (signatures.js).
// index.js does not load that file. ASSET_BASE_URL is not applied here; bucket
// upload still rewrites hosted all.json. The published file does not read package.json.
//
// Publish with: ./yarn build:package && npm publish ./dist

const PROVIDER_CHAINS = ["eip155-14", "eip155-19"] as const;

function publishEntry<T extends { logoURL: string }>(entry: T, label: string): T {
  const published = withRelativeLogoURL(entry);
  if (/^https:\/\//i.test(published.logoURL)) {
    throw new Error(`${label}: published logoURL must stay relative, got ${entry.logoURL}`);
  }
  return published;
}

function loadProviders(chainPath: string): ProviderInfo[] {
  const allPath = path.join(process.cwd(), "data", "providers", chainPath, "all.json");
  const providers = JSON.parse(fs.readFileSync(allPath, "utf8")) as ProviderInfo[];
  return providers.map((provider) =>
    publishEntry(provider, `providers/${chainPath}/${provider.identityAddress}`),
  );
}

function loadTokens(chainPath: string): Array<EvmToken | XrplToken> {
  const allPath = path.join(process.cwd(), "data", "tokens", chainPath, "all.json");
  const tokens = JSON.parse(fs.readFileSync(allPath, "utf8")) as Array<EvmToken | XrplToken>;
  return tokens.map((token, index) => publishEntry(token, `tokens/${chainPath}[${index}]`));
}

function loadContracts(chainPath: string): ContractInfo[] {
  // getContracts reads the project slug and fills in projectName, logoURL, and logoHash.
  const contracts = getContracts(chainPathToCaip2(chainPath));
  return contracts.map((contract) => {
    const label = `contracts/${chainPath}/${contract.address}`;
    if (contract.project && !contract.projectName) {
      throw new Error(`${label}: projectName was not resolved`);
    }
    if (!contract.logoURL || !contract.logoHash) {
      throw new Error(`${label}: logo was not resolved`);
    }
    return publishEntry(contract, label);
  });
}

function chainDirToCaip2(chainPath: string): string {
  const splitAt = chainPath.indexOf("-");
  return splitAt === -1
    ? chainPath
    : `${chainPath.slice(0, splitAt)}:${chainPath.slice(splitAt + 1)}`;
}

/** Operator signatures, keyed by CAIP-2 chain then lowercase identity. */
function collectProviderSignatures(): Record<string, Record<string, unknown>> {
  const byChain: Record<string, Record<string, unknown>> = {};
  const root = path.join(process.cwd(), "data", "providers");
  for (const chain of PROVIDER_CHAINS) {
    const identities: Record<string, unknown> = {};
    const chainDir = path.join(root, chain);
    if (fs.existsSync(chainDir)) {
      const dirs = fs
        .readdirSync(chainDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      for (const dir of dirs) {
        const sigPath = path.join(chainDir, dir, "signatures.json");
        if (!fs.existsSync(sigPath)) continue;
        identities[dir.toLowerCase()] = JSON.parse(fs.readFileSync(sigPath, "utf8")) as unknown;
      }
    }
    byChain[chainDirToCaip2(chain)] = identities;
  }
  return byChain;
}

const SIGNATURES_JS = `"use strict";
// @bifrostwallet/assets/signatures — generated file, do not edit.
// Opt-in entry. The package main entry does not load this file.

const signaturesByChain = require("./signatures.json");

function normalizeChainId(chainId) {
  if (typeof chainId !== "string" || !chainId.includes(":")) {
    throw new Error(
      'Use a CAIP-2 chain id (e.g. "eip155:14"). Got: ' + JSON.stringify(chainId)
    );
  }
  return chainId;
}

function getProviderSignatures(chainId, identityAddress) {
  const chain = signaturesByChain[normalizeChainId(chainId)];
  if (!chain) {
    throw new Error(
      "Unknown chain " + chainId + ". Available: " + Object.keys(signaturesByChain).join(", ")
    );
  }
  const target = String(identityAddress).toLowerCase();
  return Object.hasOwn(chain, target) ? chain[target] : null;
}

module.exports = { getProviderSignatures };
`;

const SIGNATURES_DTS = `// @bifrostwallet/assets/signatures — generated file, do not edit.
// Opt-in entry. Importing "@bifrostwallet/assets" does not load this module.

export interface ProviderSignature {
  signerName: string;
  signerAddress: string;
  messageHash: string;
  signature: string;
  date: string;
}

export interface ProviderSignatures {
  identityAddress: string;
  verificationInstructions: string;
  signatures: ProviderSignature[];
}

/** Operator signature payload for one identity, or null when this version has none. */
export declare function getProviderSignatures(
  chainId: string,
  identityAddress: string,
): ProviderSignatures | null;
`;

function writeSignatureSidecar(distDir: string): number {
  const signatures = collectProviderSignatures();
  const count = Object.values(signatures).reduce(
    (sum, chain) => sum + Object.keys(chain).length,
    0,
  );
  fs.writeFileSync(
    path.join(distDir, "signatures.json"),
    `${JSON.stringify(signatures, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(distDir, "signatures.js"), SIGNATURES_JS);
  fs.writeFileSync(path.join(distDir, "signatures.d.ts"), SIGNATURES_DTS);
  return count;
}

/** Logo bytes stay in git. The published package is listings, helpers, and the signature sidecar. */
function assertNoBundledLogos(distDir: string): void {
  const bundled: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.name !== "logo.webp") continue;
      bundled.push(path.relative(distDir, fullPath).split(path.sep).join("/"));
    }
  };
  walk(distDir);
  if (bundled.length > 0) {
    throw new Error(`Refusing to publish logo.webp files: ${bundled.slice(0, 5).join(", ")}`);
  }
}

const PUBLISHED_EXPORTS = [
  "CONTRACT_CATEGORIES",
  "CONTRACT_CATEGORY_LABELS",
  "CONTRACT_CHAIN_IDS",
  "DAPP_CATEGORIES",
  "DAPP_CATEGORY_LABELS",
  "PROVIDER_CHAIN_IDS",
  "TOKEN_CHAIN_IDS",
  "createAssets",
] as const;

/** dist/package.json matches this repo, and index.js exposes only createAssets plus catalog constants. */
function assertBuiltPackage(distDir: string): void {
  const root = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    version?: unknown;
  };
  const built = JSON.parse(fs.readFileSync(path.join(distDir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof root.version !== "string" || built.version !== root.version) {
    throw new Error(
      `Built package version ${String(built.version)} does not match package.json version ${String(
        root.version,
      )}`,
    );
  }
  const indexSource = fs.readFileSync(path.join(distDir, "index.js"), "utf8");
  if (indexSource.includes("/main/data/")) {
    throw new Error("Built index.js still falls back to the GitHub main branch");
  }
  if (
    indexSource.includes("GITHUB_ASSET_BASE_URL") ||
    indexSource.includes("DEFAULT_ASSET_BASE_URL")
  ) {
    throw new Error("Built index.js must not embed a default asset base");
  }
  if (indexSource.includes("package.json") || indexSource.includes("readFileSync")) {
    throw new Error("Built index.js must not read package.json at runtime");
  }
  const indexPath = path.join(distDir, "index.js");
  const require = createRequire(import.meta.url);
  delete require.cache[indexPath];
  const published = require(indexPath) as Record<string, unknown>;
  const keys = Object.keys(published).sort();
  const expected = [...PUBLISHED_EXPORTS].sort();
  if (keys.join(",") !== expected.join(",")) {
    throw new Error(`Unexpected package exports: ${keys.join(", ")}`);
  }
  if (typeof published.createAssets !== "function") {
    throw new Error("createAssets export is missing");
  }
  const dts = fs.readFileSync(path.join(distDir, "index.d.ts"), "utf8");
  if (!dts.includes("export interface CreateAssetsOptions")) {
    throw new Error("index.d.ts is missing CreateAssetsOptions");
  }
  if (!dts.includes("export interface Assets")) {
    throw new Error("index.d.ts is missing Assets");
  }
  const createAssetsType =
    "export declare function createAssets(options: CreateAssetsOptions): Assets";
  if (!dts.includes(createAssetsType)) {
    throw new Error("index.d.ts is missing createAssets");
  }
  if (
    dts.includes("export declare function resolveAssetURL") ||
    dts.includes("export declare function getProviders") ||
    dts.includes("GITHUB_ASSET_BASE_URL") ||
    dts.includes("DEFAULT_ASSET_BASE_URL")
  ) {
    throw new Error("index.d.ts still exports a removed entry");
  }
}

/**
 * Release tags are `v<version>` and published logoURLs are relative to `data/`.
 * The tagged commit must contain `data/<logoURL>` or the pinned GitHub URL 404s.
 */
function assertPublishedLogosExistUnderData(distDir: string): void {
  const missing: string[] = [];
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith(".json") || entry.name === "package.json") continue;
      const parsed: unknown = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item || typeof item !== "object" || !("logoURL" in item)) continue;
        const logoURL = (item as { logoURL: unknown }).logoURL;
        if (typeof logoURL !== "string" || logoURL.length === 0) continue;
        count += 1;
        if (logoURL.includes("..") || path.isAbsolute(logoURL)) {
          missing.push(logoURL);
          continue;
        }
        if (!fs.existsSync(path.join(process.cwd(), "data", logoURL))) missing.push(logoURL);
      }
    }
  };
  walk(distDir);
  if (count === 0 || missing.length > 0) {
    const sample = missing.slice(0, 5).join(", ") || "(none published)";
    throw new Error(`Release tag is missing data/ files for published logoURLs: ${sample}`);
  }
}

function buildIndexJs(tokenChains: string[], contractChains: string[]): string {
  const tokenRequires =
    tokenChains.length === 0
      ? ""
      : `${tokenChains.map((chain) => `  "${chain}": require("./tokens/${chain}.json"),`).join("\n")}\n`;
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

const contractsByChain = {
${contractRequires}};

/** Hand-ordered browser chips. Not an all.json aggregate. */
const dappCategories = require("./dapps/categories.json");

const PROVIDER_CHAIN_IDS = Object.keys(providersByChain).map(chainPathToCaip2);
const TOKEN_CHAIN_IDS = Object.keys(tokensByChain).map(chainPathToCaip2);
const CONTRACT_CHAIN_IDS = Object.keys(contractsByChain).map(chainPathToCaip2);
const CONTRACT_CATEGORIES = ${JSON.stringify([...CONTRACT_CATEGORIES])};
const CONTRACT_CATEGORY_LABELS = ${JSON.stringify(CONTRACT_CATEGORY_LABELS)};
const DAPP_CATEGORIES = ${JSON.stringify([...DAPP_CATEGORIES])};
const DAPP_CATEGORY_LABELS = ${JSON.stringify(DAPP_CATEGORY_LABELS)};

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

function collectValidators(providers) {
  const list = [];
  for (const provider of providers) {
    const nodeIds = Array.isArray(provider.validators) ? provider.validators : [];
    for (const nodeId of nodeIds) {
      list.push({
        nodeId: nodeId,
        identityAddress: provider.identityAddress,
        name: provider.name,
      });
    }
  }
  return list;
}

const validatorsByChain = {};
const listedValidatorsByChain = {};
for (const chainPath of Object.keys(providersByChain)) {
  const providers = providersByChain[chainPath];
  validatorsByChain[chainPath] = collectValidators(providers);
  listedValidatorsByChain[chainPath] = collectValidators(
    providers.filter((provider) => provider.listed)
  );
}

function validatorsForChain(chainId, byChain) {
  const validators = byChain[normalizeChainId(chainId)];
  if (!validators) {
    throw new Error(
      "Unknown chain " + chainId + ". Available: " + PROVIDER_CHAIN_IDS.join(", ")
    );
  }
  return validators;
}

function getValidators(chainId) {
  return validatorsForChain(chainId, validatorsByChain);
}

function getListedValidators(chainId) {
  return validatorsForChain(chainId, listedValidatorsByChain);
}

function getValidatorsByIdentity(chainId, identityAddress) {
  const target = String(identityAddress).toLowerCase();
  return getValidators(chainId).filter(
    (validator) => String(validator.identityAddress).toLowerCase() === target
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
  const tokens = getTokens(chainId);
  const target = String(address).toLowerCase();
  return (
    tokens.find(
      (token) => token.address && token.address.toLowerCase() === target
    ) ?? null
  );
}

function getXrplToken(issuer, currency) {
  const issuerKey = String(issuer);
  const currencyKey = String(currency);
  return (
    getTokens("xrpl:0").find(
      (token) => token.issuer === issuerKey && token.currency === currencyKey
    ) ?? null
  );
}

function getNativeToken(chainId) {
  return getTokens(chainId).find((token) => token.address === null) ?? null;
}

function contractsWithChain(chainPath, contracts) {
  const chain = chainPathToCaip2(chainPath);
  return contracts.map((contract) => ({ ...contract, chain }));
}

function getContracts(chainId) {
  if (chainId == null) {
    const all = [];
    for (const chain of Object.keys(contractsByChain).sort()) {
      all.push(...contractsWithChain(chain, contractsByChain[chain]));
    }
    return all;
  }
  const chainPath = normalizeChainId(chainId);
  const contracts = contractsByChain[chainPath];
  if (!contracts) {
    throw new Error(
      "Unknown contract chain " + chainId + ". Available: " + CONTRACT_CHAIN_IDS.join(", ")
    );
  }
  return contractsWithChain(chainPath, contracts);
}

function getContract(chainId, address) {
  const target = String(address).toLowerCase();
  return (
    getContracts(chainId).find((contract) => contract.address.toLowerCase() === target) ?? null
  );
}

function getDappCategories() {
  return dappCategories;
}

function isHttpsUrl(value) {
  return /^https:\\/\\//i.test(String(value).trim());
}

function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(value).trim());
}

function toRelativeAssetPath(logoURL) {
  const trimmed = String(logoURL).trim();
  if (isHttpsUrl(trimmed)) {
    try {
      const pathname = new URL(trimmed).pathname;
      for (const marker of ["/static/", "/data/"]) {
        const idx = pathname.indexOf(marker);
        if (idx !== -1) {
          return pathname.slice(idx + marker.length).replace(/^\\//, "");
        }
      }
    } catch {
      // fall through
    }
    const match = trimmed.match(/((?:providers|dapps|tokens|contracts)\\/[^?#]+)/);
    return match ? match[1] : trimmed;
  }
  if (hasUrlScheme(trimmed)) {
    throw new Error("Asset URL must start with https://, got " + JSON.stringify(logoURL));
  }
  return trimmed.replace(/^\\//, "");
}

function normalizeAssetBase(baseURL) {
  const supplied = typeof baseURL === "string" ? baseURL.trim() : "";
  if (!isHttpsUrl(supplied)) {
    throw new Error("Asset base must start with https://, got " + JSON.stringify(baseURL));
  }
  return supplied.replace(/\\/?$/, "/");
}

function resolveAssetURL(logoURL, baseURL) {
  const base = normalizeAssetBase(baseURL);
  const relative = toRelativeAssetPath(logoURL);
  if (isHttpsUrl(relative)) {
    return relative;
  }
  return base + relative.replace(/^\\//, "");
}

function isRelativeAssetPath(value) {
  let assetPath = String(value).trim();
  if (assetPath.startsWith("/")) assetPath = assetPath.slice(1);
  return (
    assetPath.startsWith("providers/") ||
    assetPath.startsWith("dapps/") ||
    assetPath.startsWith("tokens/") ||
    assetPath.startsWith("contracts/")
  );
}

function createAssets(options) {
  const baseURL =
    options !== null && typeof options === "object" && !Array.isArray(options)
      ? options.baseURL
      : undefined;
  const base = normalizeAssetBase(baseURL);
  const cache = new WeakMap();

  function present(value) {
    if (typeof value === "string") {
      return isRelativeAssetPath(value) ? resolveAssetURL(value, base) : value;
    }
    if (Array.isArray(value)) {
      const cached = cache.get(value);
      if (cached) return cached;
      let changed = false;
      const next = value.map((item) => {
        const resolved = present(item);
        if (resolved !== item) changed = true;
        return resolved;
      });
      if (!changed) return value;
      cache.set(value, next);
      return next;
    }
    if (!value || typeof value !== "object") return value;
    const cached = cache.get(value);
    if (cached) return cached;
    let copy = null;
    for (const key of Object.keys(value)) {
      const field = value[key];
      let resolved = field;
      if (
        (key === "logoURL" && typeof field === "string") ||
        (typeof field === "string" && isRelativeAssetPath(field))
      ) {
        resolved = resolveAssetURL(field, base);
      } else if (field && typeof field === "object") {
        resolved = present(field);
      }
      if (resolved !== field) {
        if (!copy) copy = { ...value };
        copy[key] = resolved;
      }
    }
    if (!copy) return value;
    cache.set(value, copy);
    return copy;
  }

  return {
    getProviders: (chainId) => present(getProviders(chainId)),
    getProvider: (chainId, identityAddress) => present(getProvider(chainId, identityAddress)),
    getListedProviders: (chainId) => present(getListedProviders(chainId)),
    getManagementGroupProviders: (chainId) => present(getManagementGroupProviders(chainId)),
    findProviderByValidator: (chainId, nodeId) => present(findProviderByValidator(chainId, nodeId)),
    getValidators: (chainId) => present(getValidators(chainId)),
    getListedValidators: (chainId) => present(getListedValidators(chainId)),
    getValidatorsByIdentity: (chainId, identityAddress) =>
      present(getValidatorsByIdentity(chainId, identityAddress)),
    getTokens: (chainId) => present(getTokens(chainId)),
    getToken: (chainId, address) => present(getToken(chainId, address)),
    getXrplToken: (issuer, currency) => present(getXrplToken(issuer, currency)),
    getNativeToken: (chainId) => present(getNativeToken(chainId)),
    getContracts: (chainId) => present(getContracts(chainId)),
    getContract: (chainId, address) => present(getContract(chainId, address)),
    getDappCategories: () => present(getDappCategories()),
  };
}

module.exports = {
  PROVIDER_CHAIN_IDS,
  TOKEN_CHAIN_IDS,
  CONTRACT_CHAIN_IDS,
  CONTRACT_CATEGORIES,
  CONTRACT_CATEGORY_LABELS,
  DAPP_CATEGORIES,
  DAPP_CATEGORY_LABELS,
  createAssets,
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
  /** Absolute logo URL for the baseURL passed to createAssets. */
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

export interface EvmToken {
  name: string;
  symbol: string;
  decimals: number;
  /** Lowercase 0x… for contracts; null for the native gas token. */
  address: string | null;
  /** Always present — string CoinGecko id, or null when unmapped / unpriced */
  coingeckoId: string | null;
  /** Absolute logo URL for the baseURL passed to createAssets. */
  logoURL: string;
  logoHash: string;
}

export interface XrplToken {
  name: string;
  symbol: string;
  /** Classic r-address, exact case. */
  issuer: string;
  /** On-ledger currency: 3-character exact case, or 40-hex uppercase. */
  currency: string;
  /** Always present — string CoinGecko id, or null when unmapped / unpriced */
  coingeckoId: string | null;
  /** Absolute logo URL for the baseURL passed to createAssets. */
  logoURL: string;
  logoHash: string;
}

/** CAIP-2 chain id, e.g. "eip155:14" or "eip155:19" */
export type ChainId = string;

export declare const PROVIDER_CHAIN_IDS: string[];
export declare const TOKEN_CHAIN_IDS: string[];
export declare const CONTRACT_CHAIN_IDS: string[];

export type ContractCategory =
%%CONTRACT_CATEGORY_UNION%%

/** Product-approved category ids, in display order. */
export declare const CONTRACT_CATEGORIES: readonly ContractCategory[];
/** Display names. Use these instead of hardcoding category strings. */
export declare const CONTRACT_CATEGORY_LABELS: Record<ContractCategory, string>;

export type DappCategory =
%%DAPP_CATEGORY_UNION%%

/** Browser chip ids, in chip order. Separate from contract categories. */
export declare const DAPP_CATEGORIES: readonly DappCategory[];
/** Display names for those chips. marketplaces is NFT marketplaces only. */
export declare const DAPP_CATEGORY_LABELS: Record<DappCategory, string>;

export interface DappCategoryGroup {
  id: DappCategory;
  label: string;
  /** Hand-ordered slugs. A slug may appear in more than one group. */
  dapps: string[];
}

export interface ContractInfo {
  /** Lowercase 0x address */
  address: string;
  /** CAIP-2 chain id, e.g. "eip155:14" */
  chain: string;
  /**
   * Project slug. Omitted only when the contract has its own logo and no project.
   * Resolved at package build. Consumers do not look up the project folder.
   */
  project?: string;
  /** Display name from that project. Present when project is set. */
  projectName?: string;
  contractName: string;
  category: ContractCategory;
  /** Absolute logo URL for the baseURL passed to createAssets. */
  logoURL: string;
  /** SHA-256 of that logo file, resolved at package build. */
  logoHash: string;
}

export interface ValidatorInfo {
  /** Avalanche-style NodeID */
  nodeId: string;
  /** Owning provider identity address */
  identityAddress: string;
  /** Owning provider display name */
  name: string;
}

export interface CreateAssetsOptions {
  /** Directory that contains providers/, tokens/, dapps/, and contracts/. */
  baseURL: string;
}

/** Catalog getters. logoURL values are absolute for the baseURL passed to createAssets. */
export interface Assets {
  /** All curated providers for a chain (throws on unknown chain) */
  getProviders(chainId: ChainId): ProviderInfo[];
  /** A single provider by identity address (case-insensitive), or null */
  getProvider(chainId: ChainId, identityAddress: string): ProviderInfo | null;
  /** Providers listed in Bifrost Wallet UIs */
  getListedProviders(chainId: ChainId): ProviderInfo[];
  /** Providers that are current FTSO Management Group members */
  getManagementGroupProviders(chainId: ChainId): ProviderInfo[];
  /** The provider operating a validator NodeID, or null */
  findProviderByValidator(chainId: ChainId, nodeId: string): ProviderInfo | null;
  /**
   * Every validator on a chain, in getProviders order.
   * Validators of one provider stay together, in that provider's validators order.
   * Throws on an unknown chain.
   */
  getValidators(chainId: ChainId): ValidatorInfo[];
  /** Validators of providers with listed: true, same order as getValidators. */
  getListedValidators(chainId: ChainId): ValidatorInfo[];
  /**
   * Validators for one provider identity. The address match is case-insensitive.
   * Returns an empty array when that identity is absent. Throws on an unknown chain.
   */
  getValidatorsByIdentity(chainId: ChainId, identityAddress: string): ValidatorInfo[];
  /**
   * All curated tokens for a chain (throws on unknown chain).
   * \`xrpl:0\` returns XrplToken. Every other chain returns EvmToken.
   */
  getTokens(chainId: "xrpl:0"): XrplToken[];
  getTokens(chainId: ChainId): EvmToken[];
  /** One EVM token by address (case-insensitive), or null. */
  getToken(chainId: ChainId, address: string): EvmToken | null;
  /**
   * One XRPL mainnet issued token by exact-case issuer and currency, or null.
   * There is no combined address key.
   */
  getXrplToken(issuer: string, currency: string): XrplToken | null;
  /** Native gas token entry for a chain, or null */
  getNativeToken(chainId: ChainId): EvmToken | null;
  /**
   * Curated contracts. Omit chainId for every chain.
   * Throws on an unknown CAIP-2 id.
   * Each record already includes project, projectName, logoURL, and logoHash.
   */
  getContracts(chainId?: ChainId): ContractInfo[];
  /** One contract by address (case-insensitive), or null */
  getContract(chainId: ChainId, address: string): ContractInfo | null;
  /**
   * Browser chips from data/dapps/categories.json, in curated order.
   * This is not a dapp all.json.
   */
  getDappCategories(): DappCategoryGroup[];
}

/** Catalog getters with logo URLs joined to baseURL. */
export declare function createAssets(options: CreateAssetsOptions): Assets;
`;

function buildPackage(): void {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const packageVersion = rootPackage.version;
  if (typeof packageVersion !== "string") {
    throw new Error("package.json version is required");
  }
  releaseTagForVersion(packageVersion);

  const distDir = path.join(process.cwd(), "dist");
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(distDir, "providers"), { recursive: true });

  for (const chain of PROVIDER_CHAINS) {
    const providers = loadProviders(chain);
    const outPath = path.join(distDir, "providers", `${chain}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(providers, null, 2)}\n`);
    console.info(`📦 providers/${chain}.json (${providers.length} providers)`);
  }

  const tokenChainIds = listTokenChainPaths();
  if (tokenChainIds.length > 0) {
    fs.mkdirSync(path.join(distDir, "tokens"), { recursive: true });
    for (const chain of tokenChainIds) {
      const tokens = loadTokens(chain);
      const outPath = path.join(distDir, "tokens", `${chain}.json`);
      fs.writeFileSync(outPath, `${JSON.stringify(tokens, null, 2)}\n`);
      console.info(`📦 tokens/${chain}.json (${tokens.length} tokens)`);
    }
  }

  const contractChainIds = listContractChainPaths();
  if (contractChainIds.length > 0) {
    const contractErrors = validateContractCatalog();
    if (contractErrors.length > 0) {
      throw new Error(
        `Refusing to publish an invalid contract catalog:\n${contractErrors
          .map((error) => `  ${error}`)
          .join("\n")}`,
      );
    }
    fs.mkdirSync(path.join(distDir, "contracts"), { recursive: true });
    for (const chain of contractChainIds) {
      const contracts = loadContracts(chain);
      const outPath = path.join(distDir, "contracts", `${chain}.json`);
      fs.writeFileSync(outPath, `${JSON.stringify(contracts, null, 2)}\n`);
      console.info(`📦 contracts/${chain}.json (${contracts.length} contracts)`);
    }
  }

  const categoriesSrc = path.join(process.cwd(), "data", "dapps", "categories.json");
  if (!fs.existsSync(categoriesSrc)) {
    throw new Error("data/dapps/categories.json missing");
  }
  const categoriesBody = fs.readFileSync(categoriesSrc);
  fs.mkdirSync(path.join(distDir, "dapps"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "dapps", "categories.json"), categoriesBody);
  console.info("📦 dapps/categories.json");

  fs.writeFileSync(path.join(distDir, "index.js"), buildIndexJs(tokenChainIds, contractChainIds));
  const categoryUnion = CONTRACT_CATEGORIES.map(
    (category) => `  | ${JSON.stringify(category)}`,
  ).join("\n");
  const dappCategoryUnion = DAPP_CATEGORIES.map(
    (category) => `  | ${JSON.stringify(category)}`,
  ).join("\n");
  fs.writeFileSync(
    path.join(distDir, "index.d.ts"),
    INDEX_DTS.replace("%%CONTRACT_CATEGORY_UNION%%", `${categoryUnion};`).replace(
      "%%DAPP_CATEGORY_UNION%%",
      `${dappCategoryUnion};`,
    ),
  );
  const signatureCount = writeSignatureSidecar(distDir);
  const indexSource = fs.readFileSync(path.join(distDir, "index.js"), "utf8");
  if (indexSource.includes('require("./signatures')) {
    throw new Error("index.js must not load the signatures sidecar");
  }

  const manifest = {
    name: "@bifrostwallet/assets",
    version: rootPackage.version,
    description:
      rootPackage.description ??
      "Curated catalog of FTSO providers, validators, tokens, contracts and dapps for Bifrost Wallet.",
    repository: rootPackage.repository,
    author: rootPackage.author,
    license: "MIT",
    main: "index.js",
    types: "index.d.ts",
    exports: {
      ".": {
        types: "./index.d.ts",
        default: "./index.js",
      },
      "./signatures": {
        types: "./signatures.d.ts",
        default: "./signatures.js",
      },
    },
    sideEffects: false,
    dependencies: {},
  };
  fs.writeFileSync(path.join(distDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const readmePath = path.join(process.cwd(), "README.md");
  if (!fs.existsSync(readmePath)) {
    throw new Error("README.md missing — required for the published npm README");
  }
  const publishedReadmePath = path.join(distDir, "README.md");
  fs.copyFileSync(readmePath, publishedReadmePath);
  if (!fs.readFileSync(publishedReadmePath).equals(fs.readFileSync(readmePath))) {
    throw new Error("dist/README.md does not match the repository README.md");
  }

  const written = JSON.parse(fs.readFileSync(path.join(distDir, "package.json"), "utf8"));
  const dependencyCount = Object.keys(written.dependencies ?? {}).length;
  if (dependencyCount > 0 || written.devDependencies || written.peerDependencies) {
    throw new Error("dist/package.json must not declare any dependencies");
  }

  assertNoBundledLogos(distDir);
  assertBuiltPackage(distDir);
  assertPublishedLogosExistUnderData(distDir);

  console.info("\n✅ Built zero-dependency package in dist/");
  console.info("   published JSON keeps relative logoURL; createAssets resolves it");
  console.info(`   ${signatureCount} provider signature payload(s) in ./signatures`);
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
