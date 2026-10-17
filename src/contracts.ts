import * as fs from "node:fs";
import * as path from "node:path";
import { ASSET_LOGO_REQUIREMENTS } from "./config.js";
import { isValidEvmAddress, isValidImage } from "./validate.js";
import { isWebpMagic } from "./webp.js";

/**
 * Curated contract names for Bifrost Wallet transaction review.
 * The wallet checks the user's address book first; this catalog is the
 * fallback that turns a hex address into "Project: Contract".
 *
 * Git layout (path-safe CAIP-2, same as tokens and providers):
 *   data/contracts/eip155-14/0xabc….json
 *   data/contracts/eip155-14/all.json          generated aggregate
 * Optional logos are WebP under data/, referenced by a relative logoURL:
 *   contracts/<chain>/<address>/logo.webp       per-contract mark
 *   contracts/logos/<slug>.webp                 shared project mark
 */
export const CONTRACT_CATEGORIES = [
  "aggregator",
  "router",
  "collateral-pool",
  "agent-vault",
  "staking-protocol",
  "bridge",
  "dapp-contract",
] as const;

export type ContractCategory = (typeof CONTRACT_CATEGORIES)[number];

export type ContractInfo = {
  /** Lowercase 0x address. Matches the JSON filename. */
  address: string;
  /** CAIP-2 chain id, e.g. "eip155:14". */
  chain: string;
  projectName: string;
  contractName: string;
  category: ContractCategory;
  /**
   * Relative logo path in git (absolute after package / CDN publish).
   * Omitted when the contract has no logo.
   */
  logoURL?: string;
};

export const CONTRACT_INFO_KEYS = [
  "address",
  "chain",
  "projectName",
  "contractName",
  "category",
  "logoURL",
] as const;

/** CAIP-2: namespace (3–8) ":" reference (1–32). */
const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const ADDRESS_FILE_RE = /^0x[0-9a-f]{40}\.json$/;
const DISPLAY_NAME_RE = /^[\x20-\x7E]{2,64}$/;

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
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function sortContractInfo(info: ContractInfo): ContractInfo {
  const sorted: ContractInfo = {
    address: info.address,
    chain: info.chain,
    projectName: info.projectName,
    contractName: info.contractName,
    category: info.category,
  };
  if (info.logoURL !== undefined) {
    sorted.logoURL = info.logoURL;
  }
  return sorted;
}

function isDisplayName(value: string): boolean {
  return value === value.trim() && DISPLAY_NAME_RE.test(value);
}

function isContractCategory(value: string): value is ContractCategory {
  return (CONTRACT_CATEGORIES as readonly string[]).includes(value);
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
    if (!(CONTRACT_INFO_KEYS as readonly string[]).includes(key)) {
      errors.push(`${label}: unexpected field ${key}`);
    }
  }
  for (const key of ["address", "chain", "projectName", "contractName", "category"] as const) {
    if (!(key in record)) {
      errors.push(`${label}: missing ${key}`);
    }
  }
  if (errors.length > 0) return errors;

  const address = record.address;
  const chain = record.chain;
  const projectName = record.projectName;
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

  let chainPathCaip2: string | undefined;
  try {
    chainPathCaip2 = chainPathToCaip2(ctx.chainPath);
  } catch {
    errors.push(`${label}: chain directory is not a path-safe CAIP-2 id`);
  }

  if (typeof chain !== "string" || !isCaip2(chain)) {
    errors.push(`${label}: chain must be a CAIP-2 id (e.g. "eip155:14")`);
  } else if (chainPathCaip2 && chain !== chainPathCaip2) {
    errors.push(`${label}: chain ${chain} does not match directory ${ctx.chainPath}`);
  }

  if (typeof projectName !== "string" || !isDisplayName(projectName)) {
    errors.push(`${label}: projectName must be 2–64 printable characters`);
  }
  if (typeof contractName !== "string" || !isDisplayName(contractName)) {
    errors.push(`${label}: contractName must be 2–64 printable characters`);
  }
  if (typeof category !== "string" || !isContractCategory(category)) {
    errors.push(`${label}: category must be one of ${CONTRACT_CATEGORIES.join(", ")}`);
  }

  if ("logoURL" in record) {
    errors.push(...validateContractLogo(record.logoURL, label));
  }

  return errors;
}

function validateContractLogo(logoURL: unknown, label: string): string[] {
  if (typeof logoURL !== "string" || logoURL.length === 0) {
    return [`${label}: logoURL must be a non-empty relative path when set`];
  }
  if (logoURL !== logoURL.trim() || logoURL.includes("..") || logoURL.startsWith("/")) {
    return [`${label}: logoURL must be a relative catalog path`];
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(logoURL)) {
    return [`${label}: logoURL must be relative in git (absolute only in the published package)`];
  }
  if (!logoURL.startsWith("contracts/") || !logoURL.endsWith(".webp")) {
    return [`${label}: logoURL must look like contracts/…/logo.webp`];
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
  return [];
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

export function loadContractFile(chainPath: string, fileName: string): unknown {
  const filePath = path.join(contractsRoot(), chainPath, fileName);
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

/** Per-file entries for a chain, sorted by address. */
export function aggregateContractChain(chainPath: string): ContractInfo[] {
  return listContractFiles(chainPath).map((fileName) => {
    const raw = loadContractFile(chainPath, fileName);
    return sortContractInfo(raw as ContractInfo);
  });
}

export function contractsAllPath(chainPath: string): string {
  return path.join(contractsRoot(), chainPath, "all.json");
}

export function readContractsAll(chainPath: string): ContractInfo[] {
  const allPath = contractsAllPath(chainPath);
  return JSON.parse(fs.readFileSync(allPath, "utf8")) as ContractInfo[];
}

export function rebuildContractsAllJson(chainPath: string): ContractInfo[] {
  const contracts = aggregateContractChain(chainPath);
  fs.writeFileSync(contractsAllPath(chainPath), `${JSON.stringify(contracts, null, 2)}\n`);
  return contracts;
}

export function rebuildAllContractsAllJson(): void {
  for (const chainPath of listContractChainPaths()) {
    rebuildContractsAllJson(chainPath);
  }
}

/** Structural problems in data/contracts. Empty means the catalog is valid. */
export function validateContractCatalog(): string[] {
  const errors: string[] = [];
  const root = contractsRoot();
  if (!fs.existsSync(root)) {
    return ["data/contracts is missing"];
  }

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
    const jsonFiles: string[] = [];
    for (const child of fs.readdirSync(chainDir, { withFileTypes: true })) {
      if (child.isDirectory()) {
        errors.push(...validateLogoDirectory(chainPath, child.name));
        continue;
      }
      if (child.name === "all.json" || ADDRESS_FILE_RE.test(child.name)) {
        if (child.name !== "all.json") jsonFiles.push(child.name);
        continue;
      }
      errors.push(`${chainPath}/${child.name}: unexpected file`);
    }

    for (const fileName of jsonFiles) {
      let parsed: unknown;
      try {
        parsed = loadContractFile(chainPath, fileName);
      } catch (error) {
        errors.push(
          `${chainPath}/${fileName}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
      errors.push(...validateContractRecord(parsed, { chainPath, fileName }));
    }

    const allPath = contractsAllPath(chainPath);
    if (!fs.existsSync(allPath)) {
      errors.push(`${chainPath}/all.json: missing aggregate`);
      continue;
    }
    let all: unknown;
    try {
      all = JSON.parse(fs.readFileSync(allPath, "utf8")) as unknown;
    } catch (error) {
      errors.push(
        `${chainPath}/all.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    if (!Array.isArray(all)) {
      errors.push(`${chainPath}/all.json: must be an array`);
      continue;
    }
    const expected = aggregateContractChain(chainPath);
    if (JSON.stringify(all) !== JSON.stringify(expected)) {
      errors.push(`${chainPath}/all.json: does not match per-address JSON files`);
    }
  }

  return errors;
}

function validateLogoDirectory(chainPath: string, dirName: string): string[] {
  const errors: string[] = [];
  const dir = path.join(contractsRoot(), chainPath, dirName);
  if (!/^0x[0-9a-f]{40}$/.test(dirName)) {
    errors.push(`${chainPath}/${dirName}: logo directory must be a lowercase address`);
  }
  for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!child.isFile() || child.name !== "logo.webp") {
      errors.push(`${chainPath}/${dirName}/${child.name}: only logo.webp is allowed`);
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
 */
export function getContracts(chainId?: string): ContractInfo[] {
  if (chainId === undefined) {
    return listContractChainPaths().flatMap((chainPath) => readContractsAll(chainPath));
  }
  if (!isCaip2(chainId)) {
    throw new Error(`Use a CAIP-2 chain id (e.g. "eip155:14"). Got: ${JSON.stringify(chainId)}`);
  }
  const chainPath = caip2ToChainPath(chainId);
  const allPath = contractsAllPath(chainPath);
  if (!fs.existsSync(allPath)) {
    throw new Error(
      `Unknown contract chain ${chainId}. Available: ${availableChainIds().join(", ")}`,
    );
  }
  return readContractsAll(chainPath);
}

/** One contract by address. Lookup is case-insensitive. Unknown address returns null. */
export function getContract(chainId: string, address: string): ContractInfo | null {
  const target = address.toLowerCase();
  return (
    getContracts(chainId).find((contract) => contract.address.toLowerCase() === target) ?? null
  );
}
