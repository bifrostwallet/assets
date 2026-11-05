import * as fs from "node:fs";
import * as path from "node:path";
import { ASSET_LOGO_REQUIREMENTS } from "./config.js";
import { sha256Hex } from "./convert.js";
import { isValidEvmAddress, isValidImage, isValidName } from "./validate.js";
import { isWebpMagic } from "./webp.js";

/**
 * Curated contract names for Bifrost Wallet transaction review.
 * The wallet checks the user's address book first; this catalog is the
 * fallback that turns a hex address into "Project: Contract".
 *
 * Git layout (path-safe CAIP-2):
 *   data/contracts/eip155-14/<address>.json
 *       address, optional project slug, contractName, category
 *   data/contracts/projects/<slug>/info.json    display name only
 *   data/contracts/projects/<slug>/logo.webp    shared mark
 *   data/contracts/eip155-14/<address>/logo.webp
 *       optional per-contract logo; this file wins over the project logo
 * There is no contract all.json. Source JSON does not store chain, dapp,
 * projectName, logoURL, or logoHash. getContracts resolves those for the
 * package build. The published record is what consumers read.
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
  /**
   * Project slug (`data/contracts/projects/<slug>/`).
   * Omitted only when the contract has its own logo and no project.
   */
  project?: string;
  /** Display name from that project's info.json. Present when `project` is set. */
  projectName?: string;
  contractName: string;
  category: ContractCategory;
  /** Relative path of the logo that won (own file, otherwise the project logo). */
  logoURL: string;
  /** SHA-256 of that logo file. */
  logoHash: string;
};

/** Fields stored in per-address JSON. `project` is optional. */
export const CONTRACT_FILE_KEYS = ["address", "project", "contractName", "category"] as const;

const CONTRACT_REQUIRED_KEYS = ["address", "contractName", "category"] as const;

/** CAIP-2: namespace (3–8) ":" reference (1–32). */
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const ADDRESS_FILE_RE = /^0x[0-9a-f]{40}\.json$/;
const ADDRESS_DIR_RE = /^0x[0-9a-f]{40}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROJECTS_DIR = "projects";
const PROJECT_INFO_KEYS = ["name"] as const;
const DISPLAY_NAME_RE = /^[\x20-\x7E]{2,64}$/;

type StoredContract = {
  address: string;
  project?: string;
  contractName: string;
  category: ContractCategory;
};

type ResolvedLogo = {
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

export function listContractChainPaths(): string[] {
  const root = contractsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== PROJECTS_DIR)
    .map((entry) => entry.name)
    .sort();
}

export function sortContractInfo(info: ContractInfo): ContractInfo {
  const sorted = {
    address: info.address,
    chain: info.chain,
  } as ContractInfo;
  if (info.project !== undefined) sorted.project = info.project;
  if (info.projectName !== undefined) sorted.projectName = info.projectName;
  sorted.contractName = info.contractName;
  sorted.category = info.category;
  sorted.logoURL = info.logoURL;
  sorted.logoHash = info.logoHash;
  return sorted;
}

function isContractCategory(value: string): value is ContractCategory {
  return (CONTRACT_CATEGORIES as readonly string[]).includes(value);
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function isFile(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

/** Per-contract logo, next to `<address>.json`. Wins over the project logo. */
export function ownContractLogoURL(chainPath: string, address: string): string {
  return `contracts/${chainPath}/${address}/logo.webp`;
}

export function projectLogoURL(slug: string): string {
  return `contracts/projects/${slug}/logo.webp`;
}

function dataPath(relativeLogoURL: string): string {
  return path.join(process.cwd(), "data", relativeLogoURL);
}

function projectDir(slug: string): string {
  return path.join(contractsRoot(), PROJECTS_DIR, slug);
}

function loadProjectName(slug: string): string | null {
  const infoPath = path.join(projectDir(slug), "info.json");
  if (!isFile(infoPath)) return null;
  let raw: unknown;
  try {
    raw = readJson(infoPath);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = (raw as { name?: unknown }).name;
  return typeof name === "string" ? name : null;
}

function hashLogo(relativeLogoURL: string): string | null {
  const filePath = dataPath(relativeLogoURL);
  if (!isFile(filePath)) return null;
  return sha256Hex(fs.readFileSync(filePath));
}

/**
 * Own `logo.webp` wins when the file is present. Otherwise the project logo.
 * Returns null when neither file exists.
 */
export function resolveContractLogo(
  chainPath: string,
  address: string,
  project: string | undefined,
): ResolvedLogo | null {
  const ownURL = ownContractLogoURL(chainPath, address);
  const ownHash = hashLogo(ownURL);
  if (ownHash) return { logoURL: ownURL, logoHash: ownHash };
  if (!project || !SLUG_RE.test(project)) return null;
  const sharedURL = projectLogoURL(project);
  const sharedHash = hashLogo(sharedURL);
  if (!sharedHash) return null;
  return { logoURL: sharedURL, logoHash: sharedHash };
}

function logoImageErrors(label: string, filePath: string): string[] {
  if (!isFile(filePath)) return [`${label}: logo.webp is missing`];
  const bytes = fs.readFileSync(filePath);
  if (!isWebpMagic(bytes)) return [`${label}: logo must be WebP`];
  const errors: string[] = [];
  const check = isValidImage(filePath, {
    maxSizeKB: ASSET_LOGO_REQUIREMENTS.MAX_SIZE_KB,
    minWidth: ASSET_LOGO_REQUIREMENTS.MIN_WIDTH,
    maxWidth: ASSET_LOGO_REQUIREMENTS.MAX_WIDTH,
    requireSquare: ASSET_LOGO_REQUIREMENTS.REQUIRE_SQUARE,
  });
  if (!check.isValid) {
    errors.push(...check.errors.map((error) => `${label}: ${error}`));
  }
  return errors;
}

/**
 * Validate one source contract record.
 * `fileName` is the JSON basename (`0x….json`) when the record lives in the catalog.
 * logoURL and logoHash are not stored; they are resolved at package build.
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
    if (
      key === "chain" ||
      key === "dapp" ||
      key === "projectName" ||
      key === "logoURL" ||
      key === "logoHash"
    ) {
      errors.push(`${label}: ${key} must not be stored`);
      continue;
    }
    if (!(CONTRACT_FILE_KEYS as readonly string[]).includes(key)) {
      errors.push(`${label}: unexpected field ${key}`);
    }
  }
  for (const key of CONTRACT_REQUIRED_KEYS) {
    if (!(key in record)) errors.push(`${label}: missing ${key}`);
  }
  if (errors.length > 0) return errors;

  const address = record.address;
  const contractName = record.contractName;
  const category = record.category;
  const project = record.project;

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

  if (project !== undefined && (typeof project !== "string" || !SLUG_RE.test(project))) {
    errors.push(`${label}: project must be a lowercase slug`);
  }
  if (
    typeof contractName !== "string" ||
    contractName !== contractName.trim() ||
    !DISPLAY_NAME_RE.test(contractName)
  ) {
    errors.push(`${label}: contractName must be 2–64 printable characters`);
  }
  if (typeof category !== "string" || !isContractCategory(category)) {
    errors.push(`${label}: category must be one of ${CONTRACT_CATEGORIES.join(", ")}`);
  }
  if (errors.length > 0) return errors;

  const addressText = address as string;
  const projectSlug = typeof project === "string" ? project : undefined;
  if (projectSlug) {
    const name = loadProjectName(projectSlug);
    if (name === null) {
      errors.push(`${label}: unknown project ${projectSlug}`);
    } else if (!isValidName(name)) {
      errors.push(`${label}: project ${projectSlug} name is invalid`);
    }
  }

  const logo = resolveContractLogo(ctx.chainPath, addressText, projectSlug);
  if (!logo) {
    errors.push(`${label}: needs a project or its own logo.webp`);
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

function storedContract(value: unknown): StoredContract {
  const record = value as Record<string, unknown>;
  const stored: StoredContract = {
    address: record.address as string,
    contractName: record.contractName as string,
    category: record.category as ContractCategory,
  };
  if (typeof record.project === "string") stored.project = record.project;
  return stored;
}

/** Resolve project name and logo for one stored contract. */
export function denormalizeContract(chainPath: string, value: unknown): ContractInfo {
  const stored = storedContract(value);
  const logo = resolveContractLogo(chainPath, stored.address, stored.project);
  if (!logo) {
    throw new Error(`No logo for ${chainPath}/${stored.address}`);
  }
  let projectName: string | undefined;
  if (stored.project) {
    const name = loadProjectName(stored.project);
    if (!name) {
      throw new Error(`Unknown project ${stored.project} for ${chainPath}/${stored.address}`);
    }
    projectName = name;
  }
  return sortContractInfo({
    address: stored.address,
    chain: chainPathToCaip2(chainPath),
    project: stored.project,
    projectName,
    contractName: stored.contractName,
    category: stored.category,
    logoURL: logo.logoURL,
    logoHash: logo.logoHash,
  });
}

function loadContractChain(chainPath: string): ContractInfo[] {
  return listContractFiles(chainPath).map((fileName) => {
    const filePath = path.join(contractsRoot(), chainPath, fileName);
    return denormalizeContract(chainPath, readJson(filePath));
  });
}

function validateProject(slug: string): string[] {
  const label = `contracts/projects/${slug}`;
  const dir = projectDir(slug);
  const errors: string[] = [];
  if (!SLUG_RE.test(slug)) errors.push(`${label}: slug must be lowercase`);

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== "info.json" && entry.name !== "logo.webp") {
      errors.push(`${label}: unexpected file ${entry.name}`);
    }
  }
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has("info.json")) errors.push(`${label}: missing info.json`);
  if (!names.has("logo.webp")) errors.push(`${label}: missing logo.webp`);
  else errors.push(...logoImageErrors(label, path.join(dir, "logo.webp")));

  const infoPath = path.join(dir, "info.json");
  if (!isFile(infoPath)) return errors;
  let parsed: unknown;
  try {
    parsed = readJson(infoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [...errors, `${label}: invalid JSON (${message})`];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [...errors, `${label}: info.json must be an object`];
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PROJECT_INFO_KEYS as readonly string[]).includes(key)) {
      errors.push(`${label}: unexpected field ${key}`);
    }
  }
  if (!("name" in record)) errors.push(`${label}: missing name`);
  else if (typeof record.name !== "string" || !isValidName(record.name)) {
    errors.push(`${label}: name is invalid`);
  }
  return errors;
}

function validateProjectCatalog(): string[] {
  const dir = path.join(contractsRoot(), PROJECTS_DIR);
  if (!fs.existsSync(dir)) return [];
  if (!fs.statSync(dir).isDirectory()) return ["data/contracts/projects is not a directory"];
  const errors: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      errors.push(`contracts/projects/${entry.name}: unexpected file`);
      continue;
    }
    errors.push(...validateProject(entry.name));
  }
  return errors;
}

function validateOwnLogoDir(chainPath: string, address: string): string[] {
  const label = `${chainPath}/${address}`;
  const dir = path.join(contractsRoot(), chainPath, address);
  const errors: string[] = [];
  const jsonPath = path.join(contractsRoot(), chainPath, `${address}.json`);
  if (!isFile(jsonPath)) errors.push(`${label}: logo folder has no contract JSON`);

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.name !== "logo.webp" || !entries[0].isFile()) {
    errors.push(`${label}: contract logo folder may contain only logo.webp`);
  }
  const logoPath = path.join(dir, "logo.webp");
  if (isFile(logoPath)) errors.push(...logoImageErrors(label, logoPath));
  return errors;
}

/** Structural problems in data/contracts, including project logos. */
export function validateContractCatalog(): string[] {
  const errors: string[] = [];
  const root = contractsRoot();
  if (!fs.existsSync(root)) return ["data/contracts is missing"];

  errors.push(...validateProjectCatalog());

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === PROJECTS_DIR) continue;
    if (!entry.isDirectory()) {
      errors.push(`data/contracts/${entry.name}: unexpected file`);
      continue;
    }
    const chainPath = entry.name;
    try {
      const caip2 = chainPathToCaip2(chainPath);
      if (!isCaip2(caip2)) errors.push(`${chainPath}: directory is not path-safe CAIP-2`);
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
        if (!ADDRESS_DIR_RE.test(child.name)) {
          errors.push(`${chainPath}/${child.name}: unexpected directory`);
          continue;
        }
        errors.push(...validateOwnLogoDir(chainPath, child.name));
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
    }
  }
  return errors;
}

function availableChainIds(): string[] {
  return listContractChainPaths().map((chainPath) => chainPathToCaip2(chainPath));
}

/**
 * Curated contracts. Omit `chainId` for every chain.
 * Throws on an unknown CAIP-2 id (same as getTokens).
 * `projectName`, `logoURL`, and `logoHash` are resolved from the project slug
 * (or from the contract's own logo.webp, which wins).
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
