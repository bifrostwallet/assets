import * as fs from "node:fs";
import * as path from "node:path";
import { DAPP_CATEGORIES, DAPP_CHAINS, type DappCategory, type DappInfo } from "../config.js";
import { dappSlugFromUrl, rebuildDappsAllJson, sortDappInfo, toRelativePath } from "../convert.js";
import { getValidatedInput, rl } from "../input.js";
import { isMain } from "../isMain.js";
import { isValidDescription, isValidImage, isValidName, isValidURL } from "../validate.js";

const CATEGORY_LABELS: Record<DappCategory, string> = {
  dex: "DEX",
  yield: "Yield",
  nft: "NFT",
  games: "Games",
  other: "Other",
};

async function addDapp(): Promise<void> {
  try {
    console.info("-------------------------------------------------");
    console.info("➕ Adding a dapp bookmark to Bifrost Wallet assets");
    console.info("-------------------------------------------------");

    const title = await getValidatedInput({
      prompt: "Enter dapp title",
      validator: isValidName,
      errorMessage: "Please enter a valid title (2-32 characters)",
    });

    const description = await getValidatedInput({
      prompt: "Enter dapp description",
      validator: isValidDescription,
      errorMessage: "Please enter a valid description (10-350 characters)",
    });

    const urlInput = await getValidatedInput({
      prompt: "Enter dapp URL (e.g. sparkdex.ai or https://sparkdex.ai/swap)",
      validator: (input) => {
        const url = input.startsWith("https://") ? input : `https://${input}`;
        return isValidURL(url, "website");
      },
      errorMessage: "Please enter a valid https URL (paths allowed, no query params)",
    });

    const url = urlInput.startsWith("https://") ? urlInput : `https://${urlInput}`;
    const slug = dappSlugFromUrl(url);
    const outputDir = path.join(process.cwd(), "data", "dapps", slug);

    if (fs.existsSync(outputDir)) {
      console.error(`❌ A dapp already exists at: ${toRelativePath(outputDir)}`);
      throw new Error("Dapp already exists");
    }

    const allPath = path.join(process.cwd(), "data", "dapps", "all.json");
    if (fs.existsSync(allPath)) {
      const existing = JSON.parse(fs.readFileSync(allPath, "utf8")) as DappInfo[];
      if (existing.some((dapp) => dapp.url === url || dappSlugFromUrl(dapp.url) === slug)) {
        console.error(`❌ A dapp with this URL or slug already exists: ${url}`);
        throw new Error("Duplicate dapp URL");
      }
    }

    console.info("\nSelect chains (comma-separated numbers):");
    for (const [index, chain] of DAPP_CHAINS.entries()) {
      console.info(`${index + 1}. ${chain.name}`);
    }

    const chainsInput = await getValidatedInput({
      prompt: "Enter chain choices",
      validator: (input) => {
        const parts = input.split(",").map((part) => part.trim());
        if (parts.length === 0) {
          return false;
        }
        return parts.every((part) => {
          const num = Number(part);
          return Number.isInteger(num) && num >= 1 && num <= DAPP_CHAINS.length;
        });
      },
      errorMessage: `Please enter one or more numbers from 1-${DAPP_CHAINS.length}, comma-separated`,
    });

    const chainIndexes = [
      ...new Set(chainsInput.split(",").map((part) => Number(part.trim()) - 1)),
    ];
    const chains = chainIndexes.map((index) => DAPP_CHAINS[index].caip2).sort();

    console.info("\nSelect category:");
    for (const [index, category] of DAPP_CATEGORIES.entries()) {
      console.info(`${index + 1}. ${CATEGORY_LABELS[category]}`);
    }

    const categoryInput = await getValidatedInput({
      prompt: "Enter category choice",
      validator: (input) => {
        const num = Number(input);
        return Number.isInteger(num) && num >= 1 && num <= DAPP_CATEGORIES.length;
      },
      errorMessage: `Please enter a number from 1-${DAPP_CATEGORIES.length}`,
    });
    const category = DAPP_CATEGORIES[Number(categoryInput) - 1];

    const featuredInput = await getValidatedInput({
      prompt: "Featured dapp? (yes/no)",
      validator: (input) => ["yes", "no", "y", "n"].includes(input.toLowerCase()),
      errorMessage: "Please enter 'yes' or 'no'",
    });
    const featured = featuredInput.toLowerCase().startsWith("y");

    const logoPath = await getValidatedInput({
      prompt: "Enter path to logo WebP image (e.g. /Users/you/Downloads/logo.webp)",
      validator: (input) => fs.existsSync(input) && input.toLowerCase().endsWith(".png"),
      errorMessage: "Please enter a valid path to a PNG file",
    });

    const logoValidation = isValidImage(logoPath);
    if (!logoValidation.isValid) {
      console.error("❌ Logo validation failed:");
      for (const error of logoValidation.errors) {
        console.error(`  - ${error}`);
      }
      throw new Error("Logo validation failed");
    }

    console.info(
      `✅ Dimensions: ${logoValidation.metadata?.width}x${logoValidation.metadata?.height}px`,
    );
    console.info(`✅ Size: ${logoValidation.metadata?.sizeKB.toFixed(2)}KB`);

    const logoURL = `REPLACE_WITH_YOUR_BUCKET_URL/dapps/${slug}/logo.webp`;
    const dappInfo = sortDappInfo({
      title,
      description,
      url,
      logoURL,
      chains,
      category,
      featured,
    });

    fs.mkdirSync(outputDir, { recursive: true });

    const infoPath = path.join(outputDir, "info.json");
    fs.writeFileSync(infoPath, `${JSON.stringify(dappInfo, null, 2)}\n`);
    console.info(`\n📁 Dapp information saved to: ${toRelativePath(infoPath)}`);

    const logoOutputPath = path.join(outputDir, "logo.webp");
    fs.copyFileSync(logoPath, logoOutputPath);
    console.info(`📁 Dapp logo saved to: ${toRelativePath(logoOutputPath)}`);

    rebuildDappsAllJson();
    console.info(`📁 Aggregated list updated: ${toRelativePath(allPath)}`);

    console.info("\n✅ Dapp added successfully!");
  } catch (error) {
    console.error(
      `❌ Error adding dapp: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rl.close();
  }
}

if (isMain(import.meta.url)) {
  addDapp().catch(console.error);
}

export default addDapp;
