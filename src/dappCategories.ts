import * as fs from "node:fs";
import * as path from "node:path";
import { DAPP_CATEGORIES, DAPP_CATEGORY_LABELS, type DappCategory } from "./config.js";

/** One browser chip. `dapps` is hand-ordered and may repeat a slug from another chip. */
export interface DappCategoryGroup {
  id: DappCategory;
  label: string;
  dapps: string[];
}

const GROUP_KEYS = ["id", "label", "dapps"] as const;

export function dappCategoriesPath(root = process.cwd()): string {
  return path.join(root, "data", "dapps", "categories.json");
}

/** Directory slugs under data/dapps. Files such as categories.json are ignored. */
export function listDappSlugs(root = process.cwd()): string[] {
  const dir = path.join(root, "data", "dapps");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function readDappCategories(root = process.cwd()): unknown {
  return JSON.parse(fs.readFileSync(dappCategoriesPath(root), "utf8"));
}

function isDappCategory(value: string): value is DappCategory {
  return (DAPP_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Errors for the hand-edited browser chips.
 * Does not sort dapp lists. An empty chip is valid. A slug may appear in several chips.
 */
export function dappCategoryErrors(categories: unknown, slugs: readonly string[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(categories)) {
    return ["categories.json must be an array"];
  }
  if (categories.length !== DAPP_CATEGORIES.length) {
    const order = DAPP_CATEGORIES.join(", ");
    errors.push(`categories.json must list ${DAPP_CATEGORIES.length} chips in order: ${order}`);
  }

  const seenIds = new Set<string>();
  const membership = new Set<string>();
  const knownSlugs = new Set(slugs);

  for (const [index, entry] of categories.entries()) {
    const expectedId = DAPP_CATEGORIES[index];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`categories[${index}] must be an object`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record);
    const keySet = new Set(keys);
    const extra = keys.filter((key) => !(GROUP_KEYS as readonly string[]).includes(key));
    const missing = GROUP_KEYS.filter((key) => !keySet.has(key));
    if (extra.length > 0 || missing.length > 0) {
      errors.push(`categories[${index}] keys must be id, label, dapps`);
    }

    const id = record.id;
    const idLabel = typeof id === "string" ? id : String(index);
    if (typeof id !== "string" || !isDappCategory(id)) {
      errors.push(`categories[${index}] id is not an allowed category`);
    } else if (expectedId && id !== expectedId) {
      errors.push(`categories[${index}] id must be ${expectedId}`);
    } else if (!expectedId) {
      errors.push(`categories[${index}] id ${id} is past the chip list`);
    }
    if (typeof id === "string") {
      if (seenIds.has(id)) errors.push(`category id ${id} is repeated`);
      seenIds.add(id);
      if (isDappCategory(id) && record.label !== DAPP_CATEGORY_LABELS[id]) {
        errors.push(`category ${id} label must be ${DAPP_CATEGORY_LABELS[id]}`);
      }
    }

    if (!Array.isArray(record.dapps)) {
      errors.push(`category ${idLabel} dapps must be an array`);
      continue;
    }

    const within = new Set<string>();
    for (const slug of record.dapps) {
      if (typeof slug !== "string" || slug.length === 0) {
        errors.push(`category ${idLabel} has a non-string slug`);
        continue;
      }
      if (within.has(slug)) {
        errors.push(`slug ${slug} repeats within ${idLabel}`);
      }
      within.add(slug);
      if (!knownSlugs.has(slug)) {
        errors.push(`slug ${slug} in ${idLabel} does not exist`);
        continue;
      }
      membership.add(slug);
    }
  }

  if (categories.length !== DAPP_CATEGORIES.length) {
    for (const id of DAPP_CATEGORIES) {
      if (!seenIds.has(id)) errors.push(`category id ${id} is missing`);
    }
  }

  for (const slug of slugs) {
    if (!membership.has(slug)) errors.push(`dapp ${slug} is in no category`);
  }

  return errors;
}

/** Read data/dapps/categories.json and check it against the dapp folders. */
export function validateDappCategories(root = process.cwd()): string[] {
  let categories: unknown;
  try {
    categories = readDappCategories(root);
  } catch (error) {
    return [
      `categories.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  return dappCategoryErrors(categories, listDappSlugs(root));
}
