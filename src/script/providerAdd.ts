import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ALLOWED_LINKS, type AllowedLink, type ProviderInfo } from "../config.js";
import {
  calculateHash,
  providerLogoPath,
  rebuildProvidersAllJson,
  sortProviderInfo,
  toRelativePath,
  writeFormattedJson,
} from "../convert.js";
import { getNetworkDetails, getValidatedInput, rl } from "../input.js";
import { isMain } from "../isMain.js";
import { fetchEntityData } from "../onchain.js";
import {
  isValidDescription,
  isValidEvmAddress,
  isValidImage,
  isValidName,
  isValidURL,
} from "../validate.js";
import { signProviderInfo } from "./signProviderInfo.js";

// Interactive curator flow for adding a provider manually.
//
// Providers normally self-serve through the web signing app, which submits to
// the intake service; those submissions land in the repository via
// `./yarn pull:submissions` (see src/script/pullSubmissions.ts).

/** Proper display casing for social link platforms */
const LINK_DISPLAY_NAMES: Record<AllowedLink, string> = {
  github: "GitHub",
  x: "X",
  discord: "Discord",
  telegram: "Telegram",
  youtube: "YouTube",
  reddit: "Reddit",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
};

/** Normalizes a website URL: adds https:// when missing, allows paths and subdomains */
function normalizeWebsiteURL(input: string): string {
  return input.startsWith("https://") ? input : `https://${input}`;
}

/**
 * Resolves the logo input to a local WebP file. Accepts a filesystem path or an
 * https URL (downloaded to a temporary file).
 */
async function resolveLogoFile(input: string): Promise<string> {
  if (input.startsWith("https://")) {
    const response = await fetch(input);
    if (!response.ok) {
      throw new Error(`Failed to download logo: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const tempPath = path.join(os.tmpdir(), `assets-provider-logo-${Date.now()}.webp`);
    fs.writeFileSync(tempPath, buffer);
    return tempPath;
  }
  return input;
}

/** Validates a logo file and prints its metadata, returning the hash */
function validateAndDescribeLogo(logoPath: string): string {
  const validation = isValidImage(logoPath);
  if (!validation.isValid) {
    throw new Error(`Logo validation failed:\n  - ${validation.errors.join("\n  - ")}`);
  }

  const logoHash = calculateHash(logoPath);
  console.info(`✅ Hash: ${logoHash}`);
  console.info(`✅ Dimensions: ${validation.metadata?.width}x${validation.metadata?.height}px`);
  console.info(`✅ Size: ${validation.metadata?.sizeKB.toFixed(2)}KB`);
  return logoHash;
}

async function addProvider(): Promise<void> {
  try {
    console.info("-------------------------------------------------");
    console.info("🔍 Adding a new provider to Bifrost Wallet assets");
    console.info("-------------------------------------------------");

    console.info("\nSelect blockchain:");
    console.info("1. Flare");
    console.info("2. Songbird");

    const networkInput = await getValidatedInput({
      prompt: "Enter your choice",
      validator: (input) => {
        try {
          getNetworkDetails(input);
          return true;
        } catch {
          return false;
        }
      },
      errorMessage: "Please enter either '1', '2', 'flare', or 'songbird'",
    });

    const networkDetails = getNetworkDetails(networkInput);

    const identityAddress = await getValidatedInput({
      prompt: "Enter provider identity address",
      validator: isValidEvmAddress,
      errorMessage: "Please enter a valid EVM address",
    });

    console.info("\n📡 Fetching provider details...");
    const onchain = await fetchEntityData(identityAddress, networkDetails, { log: true });

    const name = await getValidatedInput({
      prompt: "Enter provider name",
      validator: isValidName,
      errorMessage: "Name must be 2-32 characters and contain only allowed characters",
    });

    const description = await getValidatedInput({
      prompt: "Enter provider description",
      validator: isValidDescription,
      errorMessage: "Description must be 10-350 characters and contain only allowed characters",
    });

    const websiteInput = await getValidatedInput({
      prompt: "Enter website URL (e.g. example.com or example.com/provider)",
      validator: (input) => isValidURL(normalizeWebsiteURL(input), "website"),
      errorMessage: "Please enter a valid website URL (paths and subdomains are allowed)",
    });
    const websiteURL = normalizeWebsiteURL(websiteInput);

    // Logo: local path or https URL, with retry until valid
    let logoSourcePath = "";
    let logoHash = "";
    while (!logoHash) {
      const logoInput = await getValidatedInput({
        prompt:
          "Enter logo WebP: a local file path (e.g. /Users/you/logo.webp) or an https URL to a .webp",
        validator: (input) =>
          input.startsWith("https://") ||
          (fs.existsSync(input) && input.toLowerCase().endsWith(".webp")),
        errorMessage: "Please enter an existing local .webp path or an https URL",
      });

      try {
        logoSourcePath = await resolveLogoFile(logoInput);
        logoHash = validateAndDescribeLogo(logoSourcePath);
      } catch (error) {
        console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
        console.info("Please try a different logo file.");
      }
    }

    const links: ProviderInfo["links"] = {};
    for (const link of ALLOWED_LINKS) {
      const linkURL = await getValidatedInput({
        prompt: `Enter ${LINK_DISPLAY_NAMES[link]} URL`,
        validator: (input) => input === "" || isValidURL(input, link),
        errorMessage: `Please enter a valid ${LINK_DISPLAY_NAMES[link]} URL or leave empty`,
        optional: true,
      });

      if (linkURL) {
        links[link] = linkURL;
      }
    }

    const identity = identityAddress.toLowerCase();
    const info: Partial<ProviderInfo> = {
      name,
      description,
      websiteURL,
      links,
      logoURL: providerLogoPath(networkDetails.path, identity),
      logoHash,
      ...onchain,
      listed: false,
      managementGroup: false,
      domainLinked: false,
      dualNetwork: false,
    };

    const outputDir = path.join(process.cwd(), "data", "providers", networkDetails.path, identity);
    fs.mkdirSync(outputDir, { recursive: true });

    const infoPath = path.join(outputDir, "info.json");
    writeFormattedJson(infoPath, sortProviderInfo(info));
    console.info(`\n📁 Provider information saved to: ${toRelativePath(infoPath)}`);

    const logoOutputPath = path.join(outputDir, "logo.webp");
    fs.copyFileSync(logoSourcePath, logoOutputPath);
    console.info(`📁 Provider logo saved to: ${toRelativePath(logoOutputPath)}`);

    rebuildProvidersAllJson(networkDetails.path);
    console.info(`📁 Rebuilt data/providers/${networkDetails.path}/all.json`);

    // Signing prompt comes after files are saved
    const shouldSign = (
      await getValidatedInput({
        prompt: "Do you want to sign the provider info with your private key? (yes/no)",
        validator: (input) => ["yes", "no", "y", "n"].includes(input.toLowerCase()),
        errorMessage: "Please enter 'yes' or 'no'",
      })
    )
      .toLowerCase()
      .startsWith("y");

    if (shouldSign) {
      const privateKey = await getValidatedInput({
        prompt: "Enter your private key (0x...)",
        validator: (input) => input.length >= 64,
        errorMessage: "Please enter a valid private key",
      });
      await signProviderInfo(infoPath, privateKey);
    } else {
      console.info("\n⚠️ Provider info not signed. You can sign it later using:");
      console.info(`./yarn sign:provider ${toRelativePath(infoPath)} <private-key>`);
      console.info("Or ask the provider to submit through the web signing app.");
    }

    console.info("\n✅ Provider added successfully!");
  } catch (error) {
    console.error(
      `❌ Error adding provider: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

if (isMain(import.meta.url)) {
  addProvider().catch(console.error);
}

export default addProvider;
