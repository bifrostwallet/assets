import * as fs from "node:fs";
import * as path from "node:path";
import {
  ASSET_LOGO_REQUIREMENTS,
  DAPP_CHAIN_IDS,
  DAPP_INFO_KEYS,
  type DappInfo,
} from "./config.js";
import { sha256Hex } from "./convert.js";
import { dappCategoryErrors, listDappSlugs, readDappCategories } from "./dappCategories.js";
import { isValidDescription, isValidImage, isValidName, isValidURL } from "./validate.js";
import { isWebpMagic } from "./webp.js";

/** Problems that fail `check:dapps`, plus uncategorized-dapp warnings. */
export interface DappCheckResult {
  errors: string[];
  warnings: string[];
}

const HASH_RE = /^[0-9a-f]{64}$/;
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

/**
 * Validate data/dapps. Contract logos are a separate catalog.
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
  return { errors, warnings: categories.warnings };
}
