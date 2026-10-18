import * as fs from "node:fs";
import * as path from "node:path";
import { ASSET_LOGO_REQUIREMENTS } from "./config.js";
import { sha256Hex } from "./manifest.js";
import { isValidEvmAddress, isValidImage } from "./validate.js";
import { isWebpMagic } from "./webp.js";

/**
 * Curated contract names for Bifrost Wallet transaction review.
 * The wallet checks the user's address book first; this catalog is the
 * fallback that turns a hex address into "Project: Contract".
 *
 * Git layout (path-safe CAIP-2, same folder shape as tokens and providers):
 *   data/contracts/eip155-14/<address>/info.json   address record; chain is the directory
 *   data/projects/<slug>/info.json                 project name + one shared logo
 *   data/projects/<slug>/logo.webp
 * There is no aggregate all.json. getContract / getContracts read these files,
 * inject `chain`, and resolve logoURL + logoHash from the project (or from a
 * per-contract logo.webp override when that contract has its own mark).
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
  /** Lowercase 0x address. Matches the address directory. */
  address: string;
  /** CAIP-2 chain id, e.g. "eip155:14". Injected from the chain directory. */
  chain: string;
  /** Display name from the referenced project. */
  projectName: string;
  contractName: string;
  category: ContractCategory;
  /**
   * Relative logo path in git (absolute after package / CDN publish).
   * The project logo, unless this contract stores its own override.
   */
  logoURL: string;
  /** SHA-256 of the resolved logo file. */
  logoHash: string;
};

/**
 * Fields stored in per-address info.json.
 * `chain` is the directory (`eip155-14` → `eip155:14`) and must not be stored.
 * The logo lives on the project; `logoURL` / `logoHash` are an optional override.
 */
export const CONTRACT_FILE_KEYS = [
  "address",
  "project",
  "contractName",
  "category",
  "logoURL",
  "logoHash",
] as const;

/** Fields stored in data/projects/<slug>/info.json. */
export const PROJECT_FILE_KEYS = ["name", "logoURL", "logoHash"] as const;

/** CAIP-2: namespace (3–8) ":" reference (1–32). */
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const ADDRESS_DIR_RE = /^0x[0-9a-f]{40}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DISPLAY_NAME_RE = /^[\x20-\x7E]{2,64}$/;

type StoredContract = {
  address: string;
  project: string;
  contractName: string;
  category: ContractCategory;
  logoURL?: string;
  logoHash?: string;
};

type ProjectRecord = {
  name: string;
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

export function projectsRoot(): string {
  return path.join(process.cwd(), "data", "projects");
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

/**
 * Validate one contract record.
 * `dirName` is the address directory when the record lives in the catalog.
 */
export function validateContractRecord(
  value: unknown,
  ctx: { chainPath: string; dirName?: string },
): string[] {
  const errors: string[] = [];
  const label = ctx.dirName ? `${ctx.chainPath}/${ctx.dirName}` : ctx.chainPath;

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${label}: entry must be an object`];
  }
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (key === "chain") {
      errors.push(`${label}: chain must not be stored; the directory is the chain`);
      continue;
    }
    if (key === "projectName") {
      errors.push(`${label}: projectName must not be stored; reference the project by slug`);
      continue;
    }
    if (!(CONTRACT_FILE_KEYS as readonly string[]).includes(key)) {
      errors.push(`${label}: unexpected field ${key}`);
    }
  }
  for (const key of ["address", "project", "contractName", "category"] as const) {
    if (!(key in record)) {
      errors.push(`${label}: missing ${key}`);
    }
  }
  if (errors.length > 0) return errors;

  const address = record.address;
  const project = record.project;
  const contractName = record.contractName;
  const category = record.category;

  if (typeof address !== "string" || !isValidEvmAddress(address)) {
    errors.push(`${label}: address must be a valid EVM address`);
  } else if (address !== address.toLowerCase()) {
    errors.push(`${label}: address must be lowercase (checksum-agnostic)`);
  }

  if (ctx.dirName) {
    if (!ADDRESS_DIR_RE.test(ctx.dirName)) {
      errors.push(`${label}: directory must be a lowercase 0x address`);
    } else if (typeof address === "string" && ctx.dirName !== address.toLowerCase()) {
      errors.push(`${label}: directory does not match address`);
    }
  }

  if (typeof project !== "string" || !SLUG_RE.test(project)) {
    errors.push(`${label}: project must be a lowercase slug`);
  }
  if (typeof contractName !== "string" || !isDisplayName(contractName)) {
    errors.push(`${label}: contractName must be 2–64 printable characters`);
  }
  if (typeof category !== "string" || !isContractCategory(category)) {
    errors.push(`${label}: category must be one of ${CONTRACT_CATEGORIES.join(", ")}`);
  }

  const hasLogoUrl = "logoURL" in record;
  const hasLogoHash = "logoHash" in record;
  if (hasLogoUrl || hasLogoHash) {
    if (!hasLogoUrl || !hasLogoHash) {
      errors.push(`${label}: logo override requires logoURL and logoHash`);
    } else if (typeof address === "string" && ADDRESS_DIR_RE.test(address)) {
      errors.push(
        ...validateLogoPair(
          record.logoURL,
          record.logoHash,
          `contracts/${ctx.chainPath}/${address}/logo.webp`,
          label,
        ),
      );
    }
  }

  return errors;
}

function validateLogoPair(
  logoURL: unknown,
  logoHash: unknown,
  expectedURL: string,
  label: string,
): string[] {
  if (typeof logoURL !== "string" || logoURL.length === 0) {
    return [`${label}: logoURL must be a non-empty relative path when set`];
  }
  if (logoURL !== logoURL.trim() || logoURL.includes("..") || logoURL.startsWith("/")) {
    return [`${label}: logoURL must be a relative catalog path`];
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(logoURL)) {
    return [`${label}: logoURL must be relative in git (absolute only in the published package)`];
  }
  if (logoURL !== expectedURL) {
    return [`${label}: logoURL must be ${expectedURL}`];
  }

  const filePath = path.join(process.cwd(), "data", logoURL);
  if (!fs.existsSync(filePath)) {
    return [`${label}: logo file missing at data/${logoURL}`];
  }
  const bytes = fs.readFileSync(filePath);
  if (!isWebpMagic(bytes)) {
    return [`${label}: logo must be WebP`];
  }
  const check = isValidImage(filePath, {
    maxSizeKB: ASSET_LOGO_REQUIREMENTS.MAX_SIZE_KB,
    minWidth: ASSET_LOGO_REQUIREMENTS.MIN_WIDTH,
    maxWidth: ASSET_LOGO_REQUIREMENTS.MAX_WIDTH,
    requireSquare: ASSET_LOGO_REQUIREMENTS.REQUIRE_SQUARE,
  });
  if (!check.isValid) {
    return check.errors.map((error) => `${label}: ${error}`);
  }
  if (typeof logoHash !== "string" || !HASH_RE.test(logoHash)) {
    return [`${label}: logoHash must be a lowercase SHA-256 hex digest`];
  }
  if (sha256Hex(bytes) !== logoHash) {
    return [`${label}: logoHash does not match logo.webp`];
  }
  return [];
}

function listAddressDirs(chainPath: string): string[] {
  const dir = path.join(contractsRoot(), chainPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ADDRESS_DIR_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function loadProjects(): Map<string, ProjectRecord> {
  const projects = new Map<string, ProjectRecord>();
  const root = projectsRoot();
  if (!fs.existsSync(root)) return projects;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const infoPath = path.join(root, entry.name, "info.json");
    if (!fs.existsSync(infoPath)) continue;
    projects.set(entry.name, readJson(infoPath) as ProjectRecord);
  }
  return projects;
}

/** Attach the directory chain and the project (or override) logo. */
function resolveContract(
  chainPath: string,
  record: StoredContract,
  projects: Map<string, ProjectRecord>,
): ContractInfo {
  const project = projects.get(record.project);
  if (!project) {
    throw new Error(`Unknown project ${record.project} for ${chainPath}/${record.address}`);
  }
  return sortContractInfo({
    address: record.address,
    chain: chainPathToCaip2(chainPath),
    projectName: project.name,
    contractName: record.contractName,
    category: record.category,
    logoURL: record.logoURL ?? project.logoURL,
    logoHash: record.logoHash ?? project.logoHash,
  });
}

function loadContractChain(
  chainPath: string,
  projects: Map<string, ProjectRecord>,
): ContractInfo[] {
  return listAddressDirs(chainPath).map((dirName) => {
    const record = readJson(path.join(contractsRoot(), chainPath, dirName, "info.json"));
    return resolveContract(chainPath, record as StoredContract, projects);
  });
}

/** Structural problems in data/contracts and data/projects. Empty means valid. */
export function validateContractCatalog(): string[] {
  const errors: string[] = [];
  const root = contractsRoot();
  if (!fs.existsSync(root)) {
    return ["data/contracts is missing"];
  }

  const projectSlugs = new Set<string>();
  errors.push(...validateProjectCatalog(projectSlugs));

  const usedProjects = new Set<string>();
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
      if (!child.isDirectory()) {
        errors.push(`${chainPath}/${child.name}: unexpected file`);
        continue;
      }
      errors.push(...validateAddressDirectory(chainPath, child.name, projectSlugs, usedProjects));
    }
  }

  for (const slug of [...projectSlugs].sort()) {
    if (!usedProjects.has(slug)) {
      errors.push(`projects/${slug}: project is not referenced by any contract`);
    }
  }

  return errors;
}

function validateProjectCatalog(slugs: Set<string>): string[] {
  const errors: string[] = [];
  const root = projectsRoot();
  if (!fs.existsSync(root)) {
    return ["data/projects is missing"];
  }

  const names = new Map<string, string>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      errors.push(`data/projects/${entry.name}: unexpected file`);
      continue;
    }
    const slug = entry.name;
    const label = `projects/${slug}`;
    if (!SLUG_RE.test(slug)) {
      errors.push(`${label}: directory must be a lowercase slug`);
      continue;
    }
    slugs.add(slug);

    const dir = path.join(root, slug);
    const children = fs.readdirSync(dir, { withFileTypes: true });
    const logoCount = children.filter(
      (child) => child.isFile() && child.name === "logo.webp",
    ).length;
    if (logoCount !== 1) {
      errors.push(`${label}: project must contain exactly one logo.webp`);
    }
    for (const child of children) {
      if (child.isFile() && (child.name === "info.json" || child.name === "logo.webp")) continue;
      errors.push(`${label}/${child.name}: only info.json and logo.webp are allowed`);
    }

    const infoPath = path.join(dir, "info.json");
    if (!fs.existsSync(infoPath)) {
      errors.push(`${label}: missing info.json`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = readJson(infoPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${label}/info.json: invalid JSON (${message})`);
      continue;
    }
    errors.push(...validateProjectRecord(parsed, slug, names));
  }
  return errors;
}

function validateProjectRecord(value: unknown, slug: string, names: Map<string, string>): string[] {
  const errors: string[] = [];
  const label = `projects/${slug}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${label}: entry must be an object`];
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PROJECT_FILE_KEYS as readonly string[]).includes(key)) {
      errors.push(`${label}: unexpected field ${key}`);
    }
  }
  for (const key of PROJECT_FILE_KEYS) {
    if (!(key in record)) errors.push(`${label}: missing ${key}`);
  }
  if (errors.length > 0) return errors;

  const name = record.name;
  if (typeof name !== "string" || !isDisplayName(name)) {
    errors.push(`${label}: name must be 2–64 printable characters`);
  } else if (names.has(name)) {
    errors.push(`${label}: duplicate project name "${name}" (also ${names.get(name)})`);
  } else {
    names.set(name, slug);
  }

  errors.push(
    ...validateLogoPair(record.logoURL, record.logoHash, `projects/${slug}/logo.webp`, label),
  );
  return errors;
}

function validateAddressDirectory(
  chainPath: string,
  dirName: string,
  projectSlugs: Set<string>,
  usedProjects: Set<string>,
): string[] {
  const errors: string[] = [];
  const label = `${chainPath}/${dirName}`;
  const dir = path.join(contractsRoot(), chainPath, dirName);
  if (!ADDRESS_DIR_RE.test(dirName)) {
    errors.push(`${label}: directory must be a lowercase address`);
  }

  let hasLogoFile = false;
  for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
    if (child.isFile() && child.name === "info.json") continue;
    if (child.isFile() && child.name === "logo.webp") {
      hasLogoFile = true;
      continue;
    }
    errors.push(`${label}/${child.name}: only info.json and an optional logo.webp are allowed`);
  }

  const infoPath = path.join(dir, "info.json");
  if (!fs.existsSync(infoPath)) {
    errors.push(`${label}: missing info.json`);
    return errors;
  }

  let parsed: unknown;
  try {
    parsed = readJson(infoPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${label}/info.json: invalid JSON (${message})`);
    return errors;
  }

  errors.push(...validateContractRecord(parsed, { chainPath, dirName }));
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const project = record.project;
    if (typeof project === "string" && SLUG_RE.test(project)) {
      usedProjects.add(project);
      if (!projectSlugs.has(project)) {
        errors.push(`${label}: unknown project ${project}`);
      }
    }
    const declaresOverride = "logoURL" in record || "logoHash" in record;
    if (hasLogoFile && !declaresOverride) {
      errors.push(`${label}: logo.webp requires logoURL and logoHash on info.json`);
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
 * logoURL and logoHash come from the project, or from a per-contract override.
 */
export function getContracts(chainId?: string): ContractInfo[] {
  const projects = loadProjects();
  if (chainId === undefined) {
    return listContractChainPaths().flatMap((chainPath) => loadContractChain(chainPath, projects));
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
  return loadContractChain(chainPath, projects);
}

/** One contract by address. Lookup is case-insensitive. Unknown address returns null. */
export function getContract(chainId: string, address: string): ContractInfo | null {
  const target = address.toLowerCase();
  return (
    getContracts(chainId).find((contract) => contract.address.toLowerCase() === target) ?? null
  );
}
