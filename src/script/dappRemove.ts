import * as fs from "node:fs";
import * as path from "node:path";
import type { DappInfo } from "../config.js";
import { dappSlugFromUrl, existingDappSlugForUrl, toRelativePath } from "../convert.js";
import { getValidatedInput, rl } from "../input.js";
import { isMain } from "../isMain.js";

function listedSlugForInput(input: string, slugs: readonly string[]): string | undefined {
  const trimmed = input.trim().toLowerCase();
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= slugs.length) {
    return slugs[asNumber - 1];
  }
  if (slugs.includes(trimmed)) return trimmed;
  try {
    const url = trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
    const byUrl = existingDappSlugForUrl(url);
    if (byUrl && slugs.includes(byUrl)) return byUrl;
    const derived = dappSlugFromUrl(url);
    if (slugs.includes(derived)) return derived;
  } catch {
    return undefined;
  }
  return undefined;
}

function listDappSlugs(): string[] {
  const dappsDir = path.join(process.cwd(), "data", "dapps");
  if (!fs.existsSync(dappsDir)) {
    return [];
  }

  return fs
    .readdirSync(dappsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function removeDapp(): Promise<void> {
  try {
    console.info("-------------------------------------------------");
    console.info("🗑️ Removing a dapp bookmark from Bifrost Wallet assets");
    console.info("-------------------------------------------------");

    const slugs = listDappSlugs();
    if (slugs.length === 0) {
      console.info("No curated dapps found.");
      return;
    }

    console.info("\nCurated dapps:");
    for (const [index, slug] of slugs.entries()) {
      const infoPath = path.join(process.cwd(), "data", "dapps", slug, "info.json");
      let title = slug;
      if (fs.existsSync(infoPath)) {
        const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as DappInfo;
        title = `${info.title} (${info.url})`;
      }
      console.info(`${index + 1}. ${title}`);
    }

    const selection = await getValidatedInput({
      prompt: "Enter dapp number, slug, or domain to remove",
      validator: (input) => listedSlugForInput(input, slugs) !== undefined,
      errorMessage: "Please enter a listed number, slug, or domain",
    });

    const slug = listedSlugForInput(selection, slugs);
    if (!slug) {
      throw new Error("Dapp not found");
    }

    const dappDir = path.join(process.cwd(), "data", "dapps", slug);
    if (!fs.existsSync(dappDir)) {
      console.error(`❌ Dapp not found at: ${toRelativePath(dappDir)}`);
      throw new Error("Dapp directory does not exist");
    }

    const confirmation = await getValidatedInput({
      prompt: `Are you sure you want to delete the dapp at ${toRelativePath(dappDir)}? (yes/no)`,
      validator: (input) => ["yes", "no", "y", "n"].includes(input.toLowerCase()),
      errorMessage: "Please enter 'yes' or 'no'",
    });

    if (!confirmation.toLowerCase().startsWith("y")) {
      console.info("\n❌ Deletion cancelled");
      return;
    }

    fs.rmSync(dappDir, { recursive: true, force: true });

    console.info(`\n✅ Dapp successfully removed from ${toRelativePath(dappDir)}`);
    console.info(
      `Remove ${slug} from data/dapps/categories.json by hand. That file is not updated here.`,
    );
  } catch (error) {
    console.error(
      `❌ Error removing dapp: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rl.close();
  }
}

if (isMain(import.meta.url)) {
  removeDapp().catch(console.error);
}

export default removeDapp;
