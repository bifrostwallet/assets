import * as fs from "node:fs";
import * as path from "node:path";
import { rebuildProvidersAllJson, toRelativePath } from "../convert.js";
import { getNetworkDetails, getValidatedInput, rl } from "../input.js";
import { isMain } from "../isMain.js";
import { isValidEvmAddress } from "../validate.js";

// Main function to remove a provider
async function removeProvider(): Promise<void> {
  try {
    console.info("-------------------------------------------------");
    console.info("🗑️ Removing a provider from Bifrost Wallet assets");
    console.info("-------------------------------------------------");

    // Step 1: Select network
    console.info("\nSelect blockchain:");
    console.info("1. Flare");
    console.info("2. Songbird");

    const networkInput = await getValidatedInput({
      prompt: "Enter your choice",
      validator: (input: string) => {
        return ["1", "2", "flare", "songbird"].includes(input.toLowerCase());
      },
      errorMessage: "Please enter either 'flare' or 'songbird'",
    });

    const networkDetails = getNetworkDetails(networkInput);

    // Step 2: Get identity address
    const identityAddress = await getValidatedInput({
      prompt: "Enter provider identity address to remove",
      validator: isValidEvmAddress,
      errorMessage: "Please enter a valid EVM address",
    });

    // Step 3: Construct the provider directory path
    const providerDir = path.join(
      process.cwd(),
      "data",
      "providers",
      networkDetails.path,
      identityAddress.toLowerCase(),
    );

    // Step 4: Check if the directory exists
    if (!fs.existsSync(providerDir)) {
      console.error(`❌ Provider not found at: ${toRelativePath(providerDir)}`);
      throw new Error("Provider directory does not exist");
    }

    // Step 5: Confirm deletion
    const confirmation = await getValidatedInput({
      prompt: `Are you sure you want to delete the provider at ${toRelativePath(providerDir)}? (yes/no)`,
      validator: (input: string) => ["yes", "no", "y", "n"].includes(input.toLowerCase()),
      errorMessage: "Please enter 'yes' or 'no'",
    });

    if (!confirmation.toLowerCase().startsWith("y")) {
      console.info("\n❌ Deletion cancelled");
      return;
    }

    // Step 6: Delete the directory
    fs.rmSync(providerDir, { recursive: true, force: true });

    // Step 7: Rebuild the chain aggregate
    rebuildProvidersAllJson(networkDetails.path);
    console.info(`📁 Rebuilt data/providers/${networkDetails.path}/all.json`);

    console.info(`\n✅ Provider successfully removed from ${toRelativePath(providerDir)}`);
  } catch (error) {
    console.error(
      `❌ Error removing provider: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rl.close();
  }
}

// Run the script
if (isMain(import.meta.url)) {
  removeProvider().catch(console.error);
}

export default removeProvider;
