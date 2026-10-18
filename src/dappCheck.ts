import * as fs from "node:fs";
import * as path from "node:path";
import {
  ASSET_LOGO_REQUIREMENTS,
  DAPP_CHAIN_IDS,
  DAPP_INFO_KEYS,
  type DappInfo,
} from "./config.js";
import { dappCategoryErrors, listDappSlugs, readDappCategories } from "./dappCategories.js";
import { sha256Hex } from "./manifest.js";
import { isValidDescription, isValidImage, isValidName, isValidURL } from "./validate.js";
import { isWebpMagic } from "./webp.js";

/** Problems that fail `check:dapps`, plus uncategorized-dapp warnings. */
export interface DappCheckResult {
  errors: string[];
  warnings: string[];
}

const HASH_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UNCATEGORIZED_RE = /^dapp .+ is in no category$/;
const ALLOWED_CHAINS = new Set<string>(DAPP_CHAIN_IDS);

function dappsDir(root: string): string {
  return path.join(root, "data", "dapps");
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function infoErrors(slug: string, value: unknown): string[] {
  const label = `dapps/${slug}/info.json`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [`${label}: entry must be an object`];
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  const keys = Object.keys(record);
  const missing = DAPP_INFO_KEYS.filter((key) => !(key in record));
  const extra = keys.filter((key) => !(DAPP_INFO_KEYS as readonly string[]).includes(key));
  if (missing.length > 0) errors.push(`${label}: missing ${missing.join(", ")}`);
  if (extra.length > 0) errors.push(`${label}: unexpected field ${extra.join(", ")}`);

  if ("title" in record && (typeof record.title !== "string" || !isValidName(record.title))) {
    errors.push(`${label}: title is invalid`);
  }
  if (
    "description" in record &&
    (typeof record.description !== "string" || !isValidDescription(record.description))
  ) {
    errors.push(`${label}: description is invalid`);
  }
  if ("url" in record && (typeof record.url !== "string" || !isValidURL(record.url, "website"))) {
    errors.push(`${label}: url must be https`);
  }
  const expectedLogo = `dapps/${slug}/logo.webp`;
  if ("logoURL" in record && record.logoURL !== expectedLogo) {
    errors.push(`${label}: logoURL must be ${expectedLogo}`);
  }
  if (
    "logoHash" in record &&
    (typeof record.logoHash !== "string" || !HASH_RE.test(record.logoHash))
  ) {
    errors.push(`${label}: logoHash must be a lowercase SHA-256 hex digest`);
  }
  if ("chains" in record) {
    if (!Array.isArray(record.chains) || record.chains.length === 0) {
      errors.push(`${label}: chains must be a non-empty array of CAIP-2 ids`);
    } else {
      for (const [index, chain] of record.chains.entries()) {
        if (typeof chain !== "string" || !ALLOWED_CHAINS.has(chain)) {
          errors.push(`${label}: chains[${index}] is not an allowed CAIP-2 chain`);
        }
      }
    }
  }
  return errors;
}

function logoErrors(root: string, slug: string, claimedHash: string | undefined): string[] {
  const label = `dapps/${slug}`;
  const relative = `dapps/${slug}/logo.webp`;
  const filePath = path.join(root, "data", relative);
  if (!fs.existsSync(filePath)) {
    return [`${label}: logo.webp is missing`];
  }
  const bytes = fs.readFileSync(filePath);
  if (!isWebpMagic(bytes)) {
    return [`${label}: logo must be WebP`];
  }
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
  if (claimedHash !== undefined && HASH_RE.test(claimedHash) && sha256Hex(bytes) !== claimedHash) {
    errors.push(`${label}: logoHash does not match logo.webp`);
  }
  return errors;
}

function categoryIssues(
  root: string,
  slugs: readonly string[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let categories: unknown;
  try {
    categories = readDappCategories(root);
  } catch (error) {
    return {
      errors: [
        `categories.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
      ],
      warnings,
    };
  }
  for (const issue of dappCategoryErrors(categories, slugs)) {
    if (UNCATEGORIZED_RE.test(issue)) warnings.push(issue);
    else errors.push(issue);
  }
  return { errors, warnings };
}

function readLinkedLogoHash(
  root: string,
  slug: string,
): { present: boolean; logoHash: string | undefined } {
  if (!SLUG_RE.test(slug)) return { present: false, logoHash: undefined };
  const infoPath = path.join(dappsDir(root), slug, "info.json");
  if (!fs.existsSync(infoPath)) return { present: false, logoHash: undefined };
  try {
    const raw = readJson(infoPath);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { present: true, logoHash: undefined };
    }
    const logoHash = (raw as { logoHash?: unknown }).logoHash;
    return { present: true, logoHash: typeof logoHash === "string" ? logoHash : undefined };
  } catch {
    return { present: true, logoHash: undefined };
  }
}

function contractLinkErrors(root: string): string[] {
  const errors: string[] = [];
  const contractsDir = path.join(root, "data", "contracts");
  if (!fs.existsSync(contractsDir)) return errors;

  for (const chain of fs.readdirSync(contractsDir, { withFileTypes: true })) {
    if (!chain.isDirectory()) continue;
    const chainDir = path.join(contractsDir, chain.name);
    for (const file of fs.readdirSync(chainDir, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".json")) continue;
      const label = `contracts/${chain.name}/${file.name}`;
      let raw: unknown;
      try {
        raw = readJson(path.join(chainDir, file.name));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${label}: invalid JSON (${message})`);
        continue;
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push(`${label}: dapp slug does not exist`);
        continue;
      }
      const record = raw as { dapp?: unknown; logoHash?: unknown };
      if (typeof record.dapp !== "string") {
        errors.push(`${label}: dapp slug does not exist`);
        continue;
      }
      const linked = readLinkedLogoHash(root, record.dapp);
      if (!linked.present) {
        errors.push(`${label}: dapp slug ${record.dapp} does not exist`);
        continue;
      }
      if (
        typeof record.logoHash !== "string" ||
        linked.logoHash === undefined ||
        record.logoHash !== linked.logoHash
      ) {
        errors.push(`${label}: logoHash differs from dapp ${record.dapp}`);
      }
    }
  }
  return errors;
}

/**
 * Validate data/dapps and the contract logo copies that point at them.
 * A dapp in no browser chip is a warning. Every other problem is an error.
 */
export function checkDappCatalog(root = process.cwd()): DappCheckResult {
  const errors: string[] = [];
  const dir = dappsDir(root);
  if (!fs.existsSync(dir)) {
    return { errors: ["data/dapps is missing"], warnings: [] };
  }

  const slugs = listDappSlugs(root);
  for (const slug of slugs) {
    const infoPath = path.join(dir, slug, "info.json");
    if (!fs.existsSync(infoPath)) {
      errors.push(`dapps/${slug}/info.json: missing info.json`);
      errors.push(...logoErrors(root, slug, undefined));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = readJson(infoPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`dapps/${slug}/info.json: invalid JSON (${message})`);
      errors.push(...logoErrors(root, slug, undefined));
      continue;
    }
    errors.push(...infoErrors(slug, parsed));
    const claimed =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Partial<DappInfo>).logoHash
        : undefined;
    errors.push(...logoErrors(root, slug, typeof claimed === "string" ? claimed : undefined));
  }

  const categories = categoryIssues(root, slugs);
  errors.push(...categories.errors);
  errors.push(...contractLinkErrors(root));
  return { errors, warnings: categories.warnings };
}
