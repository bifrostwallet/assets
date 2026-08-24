import * as fs from "node:fs";
import * as path from "node:path";
import type { DappInfo } from "../config.js";
import { dappSlugFromUrl, rebuildDappsAllJson, toRelativePath } from "../convert.js";
import { getValidatedInput, rl } from "../input.js";
import { isMain } from "../isMain.js";

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
      validator: (input) => {
        const trimmed = input.trim().toLowerCase();
        const asNumber = Number(trimmed);
        if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= slugs.length) {
          return true;
        }
        if (slugs.includes(trimmed)) {
          return true;
        }
        try {
          const url = trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
          return slugs.includes(dappSlugFromUrl(url));
        } catch {
          return false;
        }
      },
      errorMessage: "Please enter a listed number, slug, or domain",
    });

    const trimmed = selection.trim().toLowerCase();
    let slug: string;
    const asNumber = Number(trimmed);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= slugs.length) {
      slug = slugs[asNumber - 1];
    } else if (slugs.includes(trimmed)) {
      slug = trimmed;
    } else {
      const url = trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
      slug = dappSlugFromUrl(url);
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
    rebuildDappsAllJson();

    console.info(`\n✅ Dapp successfully removed from ${toRelativePath(dappDir)}`);
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
