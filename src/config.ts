import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Derive GitHub raw `…/data/` base from a package.json `repository` field
 * (`git@github.com:owner/repo.git` or `https://github.com/owner/repo.git`).
 */
export function githubRawDataBaseFromRepository(repository: string): string | null {
  const trimmed = repository.trim();
  const match =
    trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i) ??
    trimmed.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match?.[1] || !match[2]) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/data/`;
}

function defaultAssetBaseURL(): string {
  // Emitted to build/src/config.js — two levels up to the repo root.
  const pkgPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "package.json",
  );
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { repository?: unknown };
  if (typeof pkg.repository === "string") {
    const fromRepo = githubRawDataBaseFromRepository(pkg.repository);
    if (fromRepo) return fromRepo;
  }
  throw new Error(
    "Could not derive DEFAULT_ASSET_BASE_URL from package.json repository (expected a GitHub URL)",
  );
}

/**
 * Default logo host for published lists (all.json / NPM): GitHub raw for this repo.
 * Per-entry info.json keeps a relative logoURL; aggregates expand via ASSET_BASE_URL
 * (see src/assetUrl.ts). Operators publishing to their own CDN set ASSET_BASE_URL.
 */
export const DEFAULT_ASSET_BASE_URL = defaultAssetBaseURL();

/**
 * GCS bucket / project for curated static assets (upload:bucket).
 * Set via env or `./yarn with:ops-config` (Secret Manager). No host/bucket defaults
 * in-repo so forks do not target someone else's infrastructure by accident.
 */
export const BUCKET_NAME = process.env.STATIC_BUCKET ?? process.env.BUCKET_NAME ?? "";
export const PROJECT_ID = process.env.STATIC_BUCKET_PROJECT_ID ?? process.env.GCP_PROJECT_ID ?? "";
/** Optional object key prefix inside the bucket (e.g. "static/"), set at upload time */
export const BUCKET_PREFIX = process.env.BUCKET_PREFIX ?? "";

/**
 * Catalog logos are exact 128×128 WebP, at most 24 KB.
 * A transparent background is recommended. Opaque logos, including a solid
 * white background, stay valid: these checks do not require either.
 */
export const PROVIDER_LOGO_REQUIREMENTS = {
  MAX_SIZE_KB: 24,
  /** Exact final form produced by the listing portal converter / required on new intake. */
  WIDTH: 128,
  HEIGHT: 128,
  MIN_WIDTH: 128,
  MAX_WIDTH: 128,
  REQUIRE_SQUARE: true,
} as const;

/** Unified catalog logo rules (providers + tokens). */
export const ASSET_LOGO_REQUIREMENTS = PROVIDER_LOGO_REQUIREMENTS;

/**
 * Order of properties for links by popularity in the Web3 developer community
 * This array defines both the properties to include and their order
 */
export const ALLOWED_LINKS = [
  "github",
  "x",
  "discord",
  "telegram",
  "youtube",
  "reddit",
  "linkedin",
  "tiktok",
] as const;

/**
 * Type for links based on ALLOWED_LINKS
 */
export type AllowedLink = (typeof ALLOWED_LINKS)[number];

/**
 * Interface defining the structure of provider information
 */
export interface ProviderInfo {
  name: string;
  description: string;
  websiteURL: string;
  links: {
    [key in AllowedLink]?: string;
  };
  logoURL: string;
  logoHash: string;
  /** Canonical lowercase 0x-address (directory name matches) */
  identityAddress: string;
  /** Canonical lowercase 0x-address */
  delegationAddress: string;
  /** Canonical lowercase 0x-address */
  signingPolicyAddress: string;
  /** Canonical lowercase 0x-address */
  submitAddress: string;
  /** Canonical lowercase 0x-address */
  submitSignaturesAddress: string;
  /** Canonical lowercase 0x-hex */
  publicKey: string;
  validators: string[];
  /**
   * Provider-signed acknowledgement of listing responsibilities (portal checkbox; not curator-verified).
   * Optional on legacy catalog entries; missing defaults to acknowledged.
   */
  acknowledgedResponsibilities?: boolean;
  /** Curator-granted listing flag for Bifrost Wallet UIs (not provider-signed) */
  listed: boolean;
  /**
   * This network's FTSO Management Group membership, synced from that network's
   * PollingManagementGroup. Flare and Songbird each have their own group
   * (not provider-signed).
   */
  managementGroup: boolean;
  /**
   * Optional domain linkage (well-known file and/or DNS TXT), refreshed nightly
   * from the provider's curated websiteURL (not provider-signed).
   */
  domainLinked: boolean;
  /**
   * Same brand present on both Flare and Songbird in this catalog, maintained
   * by sync:dual-network (curator-reviewed heuristic; not provider-signed).
   */
  dualNetwork: boolean;
  /**
   * Earliest known provider activity on this network, filled write-once by
   * scan:first-transaction (curator-managed; not provider-signed):
   * - FTSOv1 era: first outgoing transaction of the delegation address before
   *   the network's EntityManager existed
   * - FTSOv2 era: the identity address's EntityManager registration transaction
   */
  firstTransaction?: {
    /** Transaction hash (verifiable on the network explorer) */
    hash: string;
    blockNumber: number;
    /** ISO 8601 UTC */
    timestamp: string;
  };
}

/**
 * Order of properties for provider info objects
 * This array defines both the properties to include and their order
 */
export const PROVIDER_INFO_KEYS = [
  "name",
  "description",
  "logoURL",
  "logoHash",
  "websiteURL",
  "links",
  "identityAddress",
  "delegationAddress",
  "signingPolicyAddress",
  "submitAddress",
  "submitSignaturesAddress",
  "publicKey",
  "validators",
  "acknowledgedResponsibilities",
  "listed",
  "managementGroup",
  "domainLinked",
  "dualNetwork",
  "firstTransaction",
] as const;

/**
 * Fields excluded from the provider-signed payload:
 * - "listed", "managementGroup", "domainLinked", "dualNetwork", and
 *   "firstTransaction" are curator/automation-derived and may change or
 *   appear after signing
 * - "logoURL" is a hosting detail (relative in info.json; absolute in published all.json);
 *   logo content integrity is covered by the signed "logoHash"
 * - delegation, submit, signing-policy, public key, and validators are chain
 *   facts. The nightly job may update them without a new signature.
 */
export const UNSIGNED_PROVIDER_INFO_KEYS = [
  "logoURL",
  "listed",
  "managementGroup",
  "domainLinked",
  "dualNetwork",
  "firstTransaction",
  "delegationAddress",
  "signingPolicyAddress",
  "submitAddress",
  "submitSignaturesAddress",
  "publicKey",
  "validators",
] as const;

/**
 * The subset of provider info covered by signatures.json (order preserved)
 */
export const SIGNED_PROVIDER_INFO_KEYS = PROVIDER_INFO_KEYS.filter(
  (key) => !(UNSIGNED_PROVIDER_INFO_KEYS as readonly string[]).includes(key),
);

/**
 * Browser chips for the dapp browser, in chip order.
 * Separate from contract categories. Membership is the hand-edited
 * `data/dapps/categories.json`, not a field on each dapp.
 */
export const DAPP_CATEGORIES = [
  "featured",
  "dex",
  "lending",
  "yield",
  "staking",
  "bridges",
  "marketplaces",
  "social",
  "games",
  "other",
] as const;

export type DappCategory = (typeof DAPP_CATEGORIES)[number];

/** Display names for {@link DAPP_CATEGORIES}. `marketplaces` is NFT marketplaces only. */
export const DAPP_CATEGORY_LABELS: Record<DappCategory, string> = {
  featured: "Featured",
  dex: "DEX",
  lending: "Lending",
  yield: "Yield",
  staking: "Staking",
  bridges: "Bridges",
  marketplaces: "Marketplaces",
  social: "Social",
  games: "Games",
  other: "Other",
};

/**
 * Interface defining the structure of curated dapp bookmark information.
 * Browser chips are not stored here.
 */
export interface DappInfo {
  /** Display name. Contract lookups expose this as projectName. */
  title: string;
  description: string;
  url: string;
  /** Relative logo path in git (`dapps/<slug>/logo.webp`). Absolute in the published package. */
  logoURL: string;
  /** SHA-256 of logo.webp. Contract files copy this with logoURL. */
  logoHash: string;
  chains: string[];
}

/**
 * Order of properties for dapp info objects
 */
export const DAPP_INFO_KEYS = [
  "title",
  "description",
  "url",
  "logoURL",
  "logoHash",
  "chains",
] as const;

/**
 * CAIP-2 chains for dapp bookmarks — Bifrost Wallet mainnets only.
 * Flare and XRP first (most used); no Fantom; includes HyperEVM + UTXO.
 */
export const DAPP_CHAINS = [
  { caip2: "eip155:14", name: "Flare" },
  { caip2: "xrpl:0", name: "XRP" },
  { caip2: "eip155:19", name: "Songbird" },
  { caip2: "eip155:1", name: "Ethereum" },
  { caip2: "eip155:56", name: "BSC" },
  { caip2: "eip155:137", name: "Polygon" },
  { caip2: "eip155:42161", name: "Arbitrum" },
  { caip2: "eip155:10", name: "Optimism" },
  { caip2: "eip155:8453", name: "Base" },
  { caip2: "eip155:50", name: "XDC" },
  { caip2: "eip155:999", name: "HyperEVM" },
  { caip2: "bip122:000000000019d6689c085ae165831e93", name: "Bitcoin" },
  { caip2: "bip122:12a765e31ffd4059bada1e25190f6e98", name: "Litecoin" },
  { caip2: "bip122:1a91e3dace36e2be3bf030a65679fe82", name: "Dogecoin" },
] as const;

/** Allowlisted CAIP-2 ids (same order as {@link DAPP_CHAINS}) */
export const DAPP_CHAIN_IDS = DAPP_CHAINS.map((chain) => chain.caip2);

// Network configurations with web-compatible CAIP2-like identifiers ("-" replaces ":")
export interface BlockchainNetworkConfig {
  chain: number;
  path: string;
  name: string;
  symbol: string;
  rpc: string;
  explorer: string;
  entityManager: string;
}

export const BLOCKCHAIN_NETWORKS: Record<string, BlockchainNetworkConfig> = {
  flare: {
    chain: 14,
    path: "eip155-14",
    name: "Flare",
    symbol: "FLR",
    rpc: "https://flare-api.flare.network/ext/C/rpc",
    explorer: "https://flare-explorer.flare.network/",
    entityManager: "0x134b3311c6bded895556807a30c7f047d99dfdc2",
  },
  songbird: {
    chain: 19,
    path: "eip155-19",
    name: "Songbird",
    symbol: "SGB",
    rpc: "https://songbird-api.flare.network/ext/C/rpc",
    explorer: "https://songbird-explorer.flare.network/",
    entityManager: "0x46c417d0760198e94fee455ce0e223262a3d0049",
  },
};

export type NetworkConfig = (typeof BLOCKCHAIN_NETWORKS)[keyof typeof BLOCKCHAIN_NETWORKS];

/**
 * FlareContractRegistry has the same address on every Flare network. Used to resolve
 * PollingManagementGroup for the on-chain FTSO Management Group membership sync.
 * Approach adapted from the MIT-licensed BurstLabs/flareregistry.
 */
export const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
