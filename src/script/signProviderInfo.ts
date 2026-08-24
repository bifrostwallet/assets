import * as fs from "node:fs";
import * as path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { BLOCKCHAIN_NETWORKS, type BlockchainNetworkConfig } from "../config.js";
import { toRelativePath } from "../convert.js";
import {
  chainIdFromProviderPath,
  PROVIDER_VERIFICATION_INSTRUCTIONS,
  providerListingTypedData,
} from "../eip712.js";
import type { HexString } from "../validate.js";

interface SignatureEntry {
  signerName: string;
  signerAddress: HexString;
  messageHash: string;
  signature: HexString;
  date: string;
}

interface SignaturesData {
  identityAddress: string;
  verificationInstructions: string;
  signatures: SignatureEntry[];
}

// Function to sign provider info
async function signProviderInfo(providerInfoPath: string, privateKey: string): Promise<void> {
  try {
    // Read and parse the provider info
    if (!fs.existsSync(providerInfoPath)) {
      throw new Error(`Provider info file not found: ${providerInfoPath}`);
    }

    const infoContent = fs.readFileSync(providerInfoPath, "utf8");
    const providerInfo = JSON.parse(infoContent);

    // Extract the chain ID from the provider path and get the blockchain name
    const pathParts = providerInfoPath.split(path.sep);
    const chainDirIndex = pathParts.findIndex((part) => part.startsWith("eip155-"));
    const targetChainId = chainDirIndex >= 0 ? pathParts[chainDirIndex] : null;

    if (!targetChainId) {
      throw new Error(`Could not determine chain ID from path: ${providerInfoPath}`);
    }

    // Get blockchain name from config
    const blockchainName = getBlockchainNameFromPath(targetChainId);

    // Set up the wallet client with the private key
    const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, "")}`);

    // Check if this is the provider signing their own entry or another provider
    const isSelfSigning =
      account.address.toLowerCase() === providerInfo.identityAddress.toLowerCase();

    // If not self-signing, verify they are a provider who has signed their own entry
    let signingProviderName = "";
    if (!isSelfSigning) {
      const providersDir = path.resolve(path.dirname(providerInfoPath), "../..");
      const isActiveProvider = await verifyAttesterIsActiveProvider(account.address, providersDir);

      if (!isActiveProvider.valid) {
        throw new Error(`Provider signature not allowed: ${isActiveProvider.reason}`);
      }

      if (!isActiveProvider.providerName) {
        throw new Error("Provider name not found despite valid verification");
      }

      // Check if the signer is from the same chain
      if (isActiveProvider.chainId !== targetChainId) {
        throw new Error(
          `Cross-chain signing not allowed: Provider from ${getBlockchainNameFromPath(isActiveProvider.chainId)} cannot sign for ${blockchainName}`,
        );
      }

      signingProviderName = isActiveProvider.providerName;
      console.info(`👤 Signer name: ${signingProviderName}`);
    } else {
      // Provider signing their own entry - use their own name
      signingProviderName = providerInfo.name;
      console.info(`👤 Signer name: ${signingProviderName}`);
    }

    console.info(`🔑 Signer address: ${account.address}`);

    // EIP-712 typed data over the signed subset (+ explicit contentHash)
    const chainId = chainIdFromProviderPath(providerInfoPath);
    const typed = providerListingTypedData(providerInfo, chainId);
    const messageToSign = typed.contentHash;

    // Sign typed data (eth_signTypedData_v4)
    const signature = await account.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });

    // Create the signature entry
    const signatureEntry = {
      signerName: signingProviderName,
      signerAddress: account.address,
      messageHash: messageToSign,
      signature: signature,
      date: new Date().toISOString(),
    };

    // Check if signatures file already exists
    const outputDir = path.dirname(providerInfoPath);
    const outputPath = path.join(outputDir, "signatures.json");

    let signaturesData: SignaturesData = {
      identityAddress: providerInfo.identityAddress,
      verificationInstructions: PROVIDER_VERIFICATION_INSTRUCTIONS,
      signatures: [],
    };

    if (fs.existsSync(outputPath)) {
      try {
        const existingContent = fs.readFileSync(outputPath, "utf8");
        signaturesData = JSON.parse(existingContent);

        // Initialize signatures array if it doesn't exist
        if (!signaturesData.signatures) {
          signaturesData.signatures = [];
        }

        // Check if this address has already signed
        const existingIndex = signaturesData.signatures.findIndex(
          (sig: SignatureEntry) =>
            sig.signerAddress.toLowerCase() === account.address.toLowerCase(),
        );

        if (existingIndex >= 0) {
          // Update existing signature
          signaturesData.signatures[existingIndex] = signatureEntry;
        } else {
          // Add new signature
          signaturesData.signatures.push(signatureEntry);
        }
      } catch (error) {
        console.warn("⚠️ Error reading existing signatures file:", error);
        // If there's an error, we'll create a new file with just this signature
        signaturesData.signatures = [signatureEntry];
      }
    } else {
      // Create new signatures file with this signature
      signaturesData.signatures = [signatureEntry];
    }

    // Write the signatures to a file
    fs.writeFileSync(outputPath, JSON.stringify(signaturesData, null, 2));

    console.info(`✅ Successfully signed provider info for ${providerInfo.name}`);
    console.info(`📝 Signature saved to: ${toRelativePath(outputPath)}`);
  } catch (error) {
    console.error("❌ Error signing provider info:", error);
  }
}

// New function to sign all provider entries
async function signAllProviders(privateKey: string): Promise<void> {
  console.info("🔍 Scanning for provider info files...");
  const providersDir = "./data/providers";

  // Set up the wallet client with the private key
  const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, "")}`);

  // Verify they are a provider who has signed their own entry
  const isActiveProvider = await verifyAttesterIsActiveProvider(account.address, providersDir);
  if (!isActiveProvider.valid) {
    console.error(`❌ Error: ${isActiveProvider.reason}`);
    return;
  }

  if (!isActiveProvider.chainId) {
    console.error("❌ Error: Could not determine signer's chain ID");
    return;
  }

  console.info(`👤 Signer name: ${isActiveProvider.providerName}`);
  console.info(`🔑 Signer address: ${account.address}`);

  // Recursively find all info.json files
  const findInfoFiles = (dir: string): string[] => {
    let results: string[] = [];
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        results = results.concat(findInfoFiles(itemPath));
      } else if (item === "info.json") {
        results.push(itemPath);
      }
    }

    return results;
  };

  const allInfoFiles = findInfoFiles(providersDir);

  // Filter info files to only include those from the same chain as the signer
  const infoFiles = allInfoFiles.filter((file) => {
    const pathParts = file.split(path.sep);
    const chainDirIndex = pathParts.findIndex((part) => part.startsWith("eip155-"));
    const fileChainId = chainDirIndex >= 0 ? pathParts[chainDirIndex] : null;
    return fileChainId === isActiveProvider.chainId;
  });

  console.info(`📋 Found ${allInfoFiles.length} total provider info files`);
  console.info(
    `📋 Found ${infoFiles.length} provider info files on ${getBlockchainNameFromPath(isActiveProvider.chainId)}`,
  );

  // Sign all provider info files, regardless of whether they already have signatures
  console.info(
    `🔏 Signing all ${infoFiles.length} provider info files on ${getBlockchainNameFromPath(isActiveProvider.chainId)}`,
  );

  // Sign each provider info file
  for (const infoFile of infoFiles) {
    console.info(`\n🖋 Signing ${infoFile}...`);
    await signProviderInfo(infoFile, privateKey);
  }

  console.info(
    `\n✅ All provider info files (${infoFiles.length}) on ${getBlockchainNameFromPath(isActiveProvider.chainId)} have been signed or updated`,
  );
}

// Helper function to verify the attester is an active provider
async function verifyAttesterIsActiveProvider(
  address: string,
  providersDir: string,
): Promise<{
  valid: boolean;
  reason?: string;
  providerName?: string;
  providerPath?: string;
  chainId?: string;
}> {
  // Recursively find all info.json files
  const findInfoFiles = (dir: string): string[] => {
    let results: string[] = [];
    const items = fs.readdirSync(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory()) {
        results = results.concat(findInfoFiles(itemPath));
      } else if (item === "info.json") {
        results.push(itemPath);
      }
    }

    return results;
  };

  const infoFiles = findInfoFiles(providersDir);

  // Check each provider to find a match for the attester's address
  for (const infoFile of infoFiles) {
    try {
      const infoContent = fs.readFileSync(infoFile, "utf8");
      const providerInfo = JSON.parse(infoContent);

      if (providerInfo.identityAddress?.toLowerCase() === address.toLowerCase()) {
        // Found the provider, now check if they have a valid signature
        const signaturePath = path.join(path.dirname(infoFile), "signatures.json");

        // Extract the chain ID from the provider path
        const pathParts = infoFile.split(path.sep);
        const chainDirIndex = pathParts.findIndex((part) => part.startsWith("eip155-"));
        const providerChainId = chainDirIndex >= 0 ? pathParts[chainDirIndex] : null;

        if (providerInfo.listed !== true) {
          return {
            valid: false,
            reason:
              "Only listed providers can attest other entries. Your provider entry is not listed.",
            chainId: providerChainId || undefined,
          };
        }

        if (!fs.existsSync(signaturePath)) {
          return {
            valid: false,
            reason:
              "Your provider entry exists but doesn't have a signatures file. Please sign your own provider info first.",
            chainId: providerChainId || undefined,
          };
        }

        // Check if the provider has signed their own entry
        try {
          const signatureContent = fs.readFileSync(signaturePath, "utf8");
          const signatureData = JSON.parse(signatureContent);

          // Check if the provider has signed their own entry
          const selfSignature = signatureData.signatures?.find(
            (sig: SignatureEntry) => sig.signerAddress.toLowerCase() === address.toLowerCase(),
          );

          if (selfSignature) {
            // Provider exists and has signed their own entry
            return {
              valid: true,
              providerName: providerInfo.name,
              providerPath: infoFile,
              chainId: providerChainId || undefined,
            };
          }
        } catch (_error) {
          return {
            valid: false,
            reason:
              "Error reading signatures file. Please ensure your provider entry is properly signed.",
            chainId: providerChainId || undefined,
          };
        }
      }
    } catch (_error) {
      // Skip invalid files
    }
  }

  return {
    valid: false,
    reason: `No provider entry found with identity address ${address}. You must be a registered provider to attest to others.`,
  };
}

// Helper function to get blockchain name from path
function getBlockchainNameFromPath(chainPath: string | null | undefined): string {
  if (!chainPath) return "Unknown";

  // Find the network that matches the path
  for (const [_, network] of Object.entries(BLOCKCHAIN_NETWORKS) as [
    string,
    BlockchainNetworkConfig,
  ][]) {
    if (network.path === chainPath) {
      return network.name;
    }
  }

  return chainPath; // Return the path if no matching network found
}

// Main function
async function main() {
  const args = process.argv.slice(2);

  // Check if we have the right number of arguments
  if (args.length !== 2) {
    console.info("Usage:");
    console.info("  yarn sign:provider <path-to-info.json> <private-key>");
    console.info("  yarn sign:provider * <private-key>");
    console.info("");
    console.info("Examples:");
    console.info(
      "  yarn sign:provider ./data/providers/eip155-14/provider-name/info.json 0x1234...",
    );
    console.info("  yarn sign:provider * 0x1234...");
    process.exit(1);
  }

  // Now we know we have exactly 2 arguments
  const [pathOrWildcard, privateKey] = args;

  try {
    if (pathOrWildcard === "*") {
      // Handle signing all providers
      await signAllProviders(privateKey);
    } else {
      // Handle single provider signing
      await signProviderInfo(pathOrWildcard, privateKey);
    }
  } catch (error) {
    console.error("❌ Error processing provider info:", error);
  }
}

// Run the script
main().catch(console.error);

export { signProviderInfo };
