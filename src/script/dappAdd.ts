import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DAPP_CHAINS, type DappInfo } from "../config.js";
import { dappSlugFromUrl, sortDappInfo, toRelativePath } from "../convert.js";
import { convertDappLogoPng } from "../dappLogo.js";
import { getValidatedInput, rl } from "../input.js";
import { isMain } from "../isMain.js";
import { isValidDescription, isValidName, isValidURL } from "../validate.js";

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

    const dappsDir = path.join(process.cwd(), "data", "dapps");
    if (fs.existsSync(dappsDir)) {
      for (const entry of fs.readdirSync(dappsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const existingPath = path.join(dappsDir, entry.name, "info.json");
        if (!fs.existsSync(existingPath)) continue;
        const existing = JSON.parse(fs.readFileSync(existingPath, "utf8")) as DappInfo;
        if (existing.url === url || entry.name === slug) {
          console.error(`❌ A dapp with this URL or slug already exists: ${url}`);
          throw new Error("Duplicate dapp URL");
        }
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

    const logoPath = await getValidatedInput({
      prompt: "Enter path to a PNG logo (converted to 128×128 logo.webp)",
      validator: (input) => fs.existsSync(input) && input.toLowerCase().endsWith(".png"),
      errorMessage: "Please enter a valid path to a PNG file",
    });

    const webp = convertDappLogoPng(logoPath);
    const logoHash = createHash("sha256").update(webp).digest("hex");
    const logoURL = `dapps/${slug}/logo.webp`;
    const dappInfo = sortDappInfo({
      title,
      description,
      url,
      logoURL,
      logoHash,
      chains,
    });

    fs.mkdirSync(outputDir, { recursive: true });

    const infoPath = path.join(outputDir, "info.json");
    fs.writeFileSync(infoPath, `${JSON.stringify(dappInfo, null, 2)}\n`);
    console.info(`\n📁 Dapp information saved to: ${toRelativePath(infoPath)}`);

    const logoOutputPath = path.join(outputDir, "logo.webp");
    fs.writeFileSync(logoOutputPath, webp);
    console.info(`📁 Dapp logo saved to: ${toRelativePath(logoOutputPath)}`);
    console.info(
      `Add ${slug} to data/dapps/categories.json by hand. Chip order is curated and this script does not edit that file.`,
    );

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
