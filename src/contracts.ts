import * as fs from "node:fs";
import * as path from "node:path";
import { ASSET_LOGO_REQUIREMENTS } from "./config.js";
import { sha256Hex, writeFormattedJson } from "./convert.js";
import { isValidEvmAddress, isValidImage } from "./validate.js";
import { isWebpMagic } from "./webp.js";

/**
 * Curated contract names for Bifrost Wallet transaction review.
 * The wallet checks the user's address book first; this catalog is the
 * fallback that turns a hex address into "Project: Contract".
 *
 * Git layout (path-safe CAIP-2):
 *   data/contracts/eip155-14/<address>.json   address, dapp slug, name, category, logo copy
 *   data/dapps/<slug>/info.json                dapp title plus the one logo
 *   data/dapps/<slug>/logo.webp
 * There is no contract or dapp all.json and no per-contract logo file.
 * `chain` is the directory. `projectName` is the dapp title, injected on read.
 * logoURL and logoHash are copies of the dapp and must not drift.
 */
/**
 * Product-approved contract categories, in display order.
 * Adding or renaming a category needs product approval.
 */
export const CONTRACT_CATEGORIES = [
  "dex",
  "aggregator",
  "bridge",
  "lending",
  "staking",
  "yield",
  "perpetuals",
  "predictions",
  "nft-marketplace",
  "governance",
  "fassets",
  "rewards",
  "other",
] as const;

export type ContractCategory = (typeof CONTRACT_CATEGORIES)[number];

/** Display names. Consumers should use these instead of hardcoding category strings. */
export const CONTRACT_CATEGORY_LABELS: Record<ContractCategory, string> = {
  dex: "DEX",
  aggregator: "Aggregator",
  bridge: "Bridge",
  lending: "Lending",
  staking: "Staking",
  yield: "Yield",
  perpetuals: "Perpetuals",
  predictions: "Predictions",
  "nft-marketplace": "NFT Marketplace",
  governance: "Governance",
  fassets: "FAssets",
  rewards: "Rewards",
  other: "Other",
};

export type ContractInfo = {
  /** Lowercase 0x address. Matches the JSON filename. */
  address: string;
  /** CAIP-2 chain id, e.g. "eip155:14". Injected from the chain directory. */
  chain: string;
  /** Display name from the referenced dapp (`title`). */
  projectName: string;
  contractName: string;
  category: ContractCategory;
  /**
   * Copy of the dapp logo path. Relative in git, absolute in the published package.
   */
  logoURL: string;
  /** Copy of the dapp logoHash (SHA-256 of that WebP). */
  logoHash: string;
};

/**
 * Fields stored in per-address JSON.
 * `chain` is the directory and must not be stored.
 * `projectName` comes from the dapp title and must not be stored.
 */
export const CONTRACT_FILE_KEYS = [
  "address",
  "dapp",
  "contractName",
  "category",
  "logoURL",
  "logoHash",
] as const;

/** CAIP-2: namespace (3–8) ":" reference (1–32). */
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const ADDRESS_FILE_RE = /^0x[0-9a-f]{40}\.json$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DISPLAY_NAME_RE = /^[\x20-\x7E]{2,64}$/;

type StoredContract = {
  address: string;
  dapp: string;
  contractName: string;
  category: ContractCategory;
  logoURL: string;
  logoHash: string;
};

type DappLogo = {
  title: string;
  logoURL: string;
  logoHash: string;
};

export function isCaip2(value: string): boolean {
  return CAIP2_RE.test(value);
}

/** `eip155-14` → `eip155:14` (first hyphen only, same as the package helper). */
export function chainPathToCaip2(chainPath: string): string {
  const i = chainPath.indexOf("-");
  if (i <= 0 || i === chainPath.length - 1) {
    throw new Error(`Invalid contract chain path: ${chainPath}`);
  }
  return `${chainPath.slice(0, i)}:${chainPath.slice(i + 1)}`;
}

/** `eip155:14` → `eip155-14`. */
export function caip2ToChainPath(caip2: string): string {
  const i = caip2.indexOf(":");
  if (i <= 0 || i === caip2.length - 1) {
    throw new Error(`Invalid CAIP-2 chain id: ${caip2}`);
  }
  return `${caip2.slice(0, i)}-${caip2.slice(i + 1)}`;
}

export function contractsRoot(): string {
  return path.join(process.cwd(), "data", "contracts");
}

export function dappsRoot(): string {
  return path.join(process.cwd(), "data", "dapps");
}

export function listContractChainPaths(): string[] {
  const root = contractsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function sortContractInfo(info: ContractInfo): ContractInfo {
  return {
    address: info.address,
    chain: info.chain,
    projectName: info.projectName,
    contractName: info.contractName,
    category: info.category,
    logoURL: info.logoURL,
    logoHash: info.logoHash,
  };
}

function isDisplayName(value: string): boolean {
  return value === value.trim() && DISPLAY_NAME_RE.test(value);
}

function isContractCategory(value: string): value is ContractCategory {
  return (CONTRACT_CATEGORIES as readonly string[]).includes(value);
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function dappInfoPath(slug: string): string {
  return path.join(dappsRoot(), slug, "info.json");
}

function loadDappLogo(slug: string): DappLogo | null {
  const infoPath = dappInfoPath(slug);
  if (!fs.existsSync(infoPath)) return null;
  const raw = readJson(infoPath);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.title !== "string" ||
    typeof record.logoURL !== "string" ||
    typeof record.logoHash !== "string"
  ) {
    return null;
  }
  return { title: record.title, logoURL: record.logoURL, logoHash: record.logoHash };
}

/**
 * Validate one contract record.
 * `fileName` is the JSON basename (`0x….json`) when the record lives in the catalog.
 */
export function validateContractRecord(
  value: unknown,
  ctx: { chainPath: string; fileName?: string },
): string[] {
  const errors: string[] = [];
  const label = ctx.fileName ? `${ctx.chainPath}/${ctx.fileName}` : ctx.chainPath;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${label}: entry must be an object`];
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key === "chain") {
      errors.push(`${label}: chain must not be stored; the directory is the chain`);
      continue;
    }
    if (key === "project" || key === "projectName") {
      errors.push(`${label}: ${key} must not be stored; reference the dapp by slug`);
      continue;
    }
    if (!(CONTRACT_FILE_KEYS as readonly string[]).includes(key)) {
      errors.push(`${label}: unexpected field ${key}`);
    }
  }
  for (const key of CONTRACT_FILE_KEYS) {
    if (!(key in record)) errors.push(`${label}: missing ${key}`);
  }
  if (errors.length > 0) return errors;

  const address = record.address;
  const dapp = record.dapp;
  const contractName = record.contractName;
  const category = record.category;

  if (typeof address !== "string" || !isValidEvmAddress(address)) {
    errors.push(`${label}: address must be a valid EVM address`);
  } else if (address !== address.toLowerCase()) {
    errors.push(`${label}: address must be lowercase (checksum-agnostic)`);
  }

  if (ctx.fileName) {
    const expectedFile = `${typeof address === "string" ? address.toLowerCase() : ""}.json`;
    if (!ADDRESS_FILE_RE.test(ctx.fileName)) {
      errors.push(`${label}: filename must be a lowercase 0x address`);
    } else if (typeof address === "string" && ctx.fileName !== expectedFile) {
      errors.push(`${label}: filename does not match address`);
    }
  }

  if (typeof dapp !== "string" || !SLUG_RE.test(dapp)) {
    errors.push(`${label}: dapp must be a lowercase slug`);
  }
  if (typeof contractName !== "string" || !isDisplayName(contractName)) {
    errors.push(`${label}: contractName must be 2–64 printable characters`);
  }
  if (typeof category !== "string" || !isContractCategory(category)) {
    errors.push(`${label}: category must be one of ${CONTRACT_CATEGORIES.join(", ")}`);
  }
  if (typeof record.logoURL !== "string" || record.logoURL.length === 0) {
    errors.push(`${label}: logoURL must be a non-empty relative path`);
  }
  if (typeof record.logoHash !== "string" || !HASH_RE.test(record.logoHash)) {
    errors.push(`${label}: logoHash must be a lowercase SHA-256 hex digest`);
  }
  if (errors.length > 0) return errors;

  if (typeof dapp === "string" && SLUG_RE.test(dapp)) {
    const logo = loadDappLogo(dapp);
    if (!logo) {
      errors.push(`${label}: unknown dapp ${dapp}`);
    } else if (record.logoURL !== logo.logoURL || record.logoHash !== logo.logoHash) {
      errors.push(`${label}: logoURL and logoHash must match dapp ${dapp}`);
    }
  }

  return errors;
}

export function listContractFiles(chainPath: string): string[] {
  const dir = path.join(contractsRoot(), chainPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ADDRESS_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function loadContractChain(chainPath: string): ContractInfo[] {
  return listContractFiles(chainPath).map((fileName) => {
    const record = readJson(path.join(contractsRoot(), chainPath, fileName)) as StoredContract;
    const dapp = loadDappLogo(record.dapp);
    if (!dapp) {
      throw new Error(`Unknown dapp ${record.dapp} for ${chainPath}/${record.address}`);
    }
    return sortContractInfo({
      address: record.address,
      chain: chainPathToCaip2(chainPath),
      projectName: dapp.title,
      contractName: record.contractName,
      category: record.category,
      logoURL: record.logoURL,
      logoHash: record.logoHash,
    });
  });
}

/**
 * Rewrite each contract's logoURL and logoHash from its dapp.
 * Returns how many files changed. Unknown dapp slugs are left for validation.
 */
export function syncContractLogosFromDapps(): number {
  let changed = 0;
  for (const chainPath of listContractChainPaths()) {
    for (const fileName of listContractFiles(chainPath)) {
      const filePath = path.join(contractsRoot(), chainPath, fileName);
      const raw = readJson(filePath);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.dapp !== "string") continue;
      const dapp = loadDappLogo(record.dapp);
      if (!dapp) continue;
      if (record.logoURL === dapp.logoURL && record.logoHash === dapp.logoHash) continue;
      writeFormattedJson(filePath, {
        address: record.address,
        dapp: record.dapp,
        contractName: record.contractName,
        category: record.category,
        logoURL: dapp.logoURL,
        logoHash: dapp.logoHash,
      });
      changed += 1;
    }
  }
  return changed;
}

/** Structural problems in data/contracts (and the dapp logos they copy). */
export function validateContractCatalog(): string[] {
  const errors: string[] = [];
  const root = contractsRoot();
  if (!fs.existsSync(root)) {
    return ["data/contracts is missing"];
  }

  const usedDapps = new Set<string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      errors.push(`data/contracts/${entry.name}: unexpected file`);
      continue;
    }
    const chainPath = entry.name;
    try {
      const caip2 = chainPathToCaip2(chainPath);
      if (!isCaip2(caip2)) {
        errors.push(`${chainPath}: directory is not path-safe CAIP-2`);
      }
    } catch {
      errors.push(`${chainPath}: directory is not path-safe CAIP-2`);
    }

    const chainDir = path.join(root, chainPath);
    for (const child of fs.readdirSync(chainDir, { withFileTypes: true })) {
      if (child.name === "all.json") {
        errors.push(`${chainPath}/all.json: contract catalogs do not use an aggregate file`);
        continue;
      }
      if (child.isDirectory()) {
        errors.push(`${chainPath}/${child.name}: contract catalogs do not use address folders`);
        continue;
      }
      if (!ADDRESS_FILE_RE.test(child.name)) {
        errors.push(`${chainPath}/${child.name}: unexpected file`);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = readJson(path.join(chainDir, child.name));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${chainPath}/${child.name}: invalid JSON (${message})`);
        continue;
      }
      errors.push(...validateContractRecord(parsed, { chainPath, fileName: child.name }));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const dapp = (parsed as { dapp?: unknown }).dapp;
        if (typeof dapp === "string" && SLUG_RE.test(dapp)) usedDapps.add(dapp);
      }
    }
  }

  for (const slug of [...usedDapps].sort()) {
    errors.push(...validateDappLogo(slug));
  }
  return errors;
}

function validateDappLogo(slug: string): string[] {
  const errors: string[] = [];
  const label = `dapps/${slug}`;
  const logo = loadDappLogo(slug);
  if (!logo) {
    return [`${label}: missing dapp info for a referenced contract`];
  }
  const expectedURL = `dapps/${slug}/logo.webp`;
  if (logo.logoURL !== expectedURL) {
    errors.push(`${label}: logoURL must be ${expectedURL}`);
  }
  if (!HASH_RE.test(logo.logoHash)) {
    errors.push(`${label}: logoHash must be a lowercase SHA-256 hex digest`);
  }
  const filePath = path.join(process.cwd(), "data", expectedURL);
  if (!fs.existsSync(filePath)) {
    return [...errors, `${label}: logo file missing at data/${expectedURL}`];
  }
  const bytes = fs.readFileSync(filePath);
  if (!isWebpMagic(bytes)) {
    errors.push(`${label}: logo must be WebP`);
    return errors;
  }
  const check = isValidImage(filePath, {
    maxSizeKB: ASSET_LOGO_REQUIREMENTS.MAX_SIZE_KB,
    minWidth: ASSET_LOGO_REQUIREMENTS.MIN_WIDTH,
    maxWidth: ASSET_LOGO_REQUIREMENTS.MAX_WIDTH,
    requireSquare: ASSET_LOGO_REQUIREMENTS.REQUIRE_SQUARE,
  });
  if (!check.isValid) {
    errors.push(...check.errors.map((error) => `${label}: ${error}`));
  }
  if (HASH_RE.test(logo.logoHash) && sha256Hex(bytes) !== logo.logoHash) {
    errors.push(`${label}: logoHash does not match logo.webp`);
  }
  return errors;
}

function availableChainIds(): string[] {
  return listContractChainPaths().map((chainPath) => chainPathToCaip2(chainPath));
}

/**
 * Curated contracts. Omit `chainId` for every chain.
 * Throws on an unknown CAIP-2 id (same as getTokens).
 * projectName is the dapp title. logoURL and logoHash are the dapp logo copies.
 */
export function getContracts(chainId?: string): ContractInfo[] {
  if (chainId === undefined) {
    return listContractChainPaths().flatMap((chainPath) => loadContractChain(chainPath));
  }
  if (!isCaip2(chainId)) {
    throw new Error(`Use a CAIP-2 chain id (e.g. "eip155:14"). Got: ${JSON.stringify(chainId)}`);
  }
  const chainPath = caip2ToChainPath(chainId);
  const chainDir = path.join(contractsRoot(), chainPath);
  if (!fs.existsSync(chainDir) || !fs.statSync(chainDir).isDirectory()) {
    throw new Error(
      `Unknown contract chain ${chainId}. Available: ${availableChainIds().join(", ")}`,
    );
  }
  return loadContractChain(chainPath);
}

/** One contract by address. Lookup is case-insensitive. Unknown address returns null. */
export function getContract(chainId: string, address: string): ContractInfo | null {
  const target = address.toLowerCase();
  return (
    getContracts(chainId).find((contract) => contract.address.toLowerCase() === target) ?? null
  );
}
