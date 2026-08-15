import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { BLOCKCHAIN_NETWORKS, type NetworkConfig } from "./config.js";

// Create readline interface for user input
const rl = readline.createInterface({ input, output });

// Helper function to get validated input with improved readability
export async function getValidatedInput({
  prompt,
  validator,
  errorMessage,
  optional = false,
}: {
  prompt: string;
  validator: (input: string) => boolean;
  errorMessage: string;
  optional?: boolean;
}): Promise<string> {
  while (true) {
    // Display prompt on its own line
    console.info(`\n${prompt}${optional ? " (press Enter to skip):" : ":"}`);
    const input = await rl.question("> ");

    // Allow user to exit the process
    if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
      console.info("\n❌ Operation cancelled by user");
      process.exit(0);
    }

    if (optional && input === "") {
      return "";
    }

    if (validator(input)) {
      return input;
    }

    console.error(`❌ ${errorMessage}`);
  }
}

// Helper function to get network details
export function getNetworkDetails(networkInput: string): NetworkConfig {
  // Allow selection by chain ID, name, or number (1=Flare, 2=Songbird)
  const network = networkInput.toLowerCase();

  if (network === "flare" || network === "14" || network === "1") {
    return BLOCKCHAIN_NETWORKS.flare;
  }

  if (network === "songbird" || network === "19" || network === "2") {
    return BLOCKCHAIN_NETWORKS.songbird;
  }

  throw new Error("Invalid network");
}

// Export the readline interface so it can be closed by the calling code
export { rl };
