import * as fs from "node:fs";
import * as path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
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

async function signProviderInfo(providerInfoPath: string, privateKey: string): Promise<void> {
  try {
    if (!fs.existsSync(providerInfoPath)) {
      throw new Error(`Provider info file not found: ${providerInfoPath}`);
    }

    const infoContent = fs.readFileSync(providerInfoPath, "utf8");
    const providerInfo = JSON.parse(infoContent);
    const chainId = chainIdFromProviderPath(providerInfoPath);
    const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, "")}`);

    if (account.address.toLowerCase() !== providerInfo.identityAddress.toLowerCase()) {
      throw new Error(
        `Only the identity address can sign this entry (signer ${account.address}, identity ${providerInfo.identityAddress})`,
      );
    }

    console.info(`👤 Signer name: ${providerInfo.name}`);
    console.info(`🔑 Signer address: ${account.address}`);

    const typed = providerListingTypedData(providerInfo, chainId);
    const signature = await account.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });

    const signatureEntry = {
      signerName: providerInfo.name,
      signerAddress: account.address,
      messageHash: typed.contentHash,
      signature,
      date: new Date().toISOString(),
    };

    const outputPath = path.join(path.dirname(providerInfoPath), "signatures.json");

    let signaturesData: SignaturesData = {
      identityAddress: providerInfo.identityAddress,
      verificationInstructions: PROVIDER_VERIFICATION_INSTRUCTIONS,
      signatures: [],
    };

    if (fs.existsSync(outputPath)) {
      try {
        const existingContent = fs.readFileSync(outputPath, "utf8");
        signaturesData = JSON.parse(existingContent);

        if (!signaturesData.signatures) {
          signaturesData.signatures = [];
        }

        const existingIndex = signaturesData.signatures.findIndex(
          (sig: SignatureEntry) =>
            sig.signerAddress.toLowerCase() === account.address.toLowerCase(),
        );

        if (existingIndex >= 0) {
          signaturesData.signatures[existingIndex] = signatureEntry;
        } else {
          signaturesData.signatures.push(signatureEntry);
        }
      } catch (error) {
        console.warn("⚠️ Error reading existing signatures file:", error);
        signaturesData.signatures = [signatureEntry];
      }
    } else {
      signaturesData.signatures = [signatureEntry];
    }

    fs.writeFileSync(outputPath, JSON.stringify(signaturesData, null, 2));

    console.info(`✅ Successfully signed provider info for ${providerInfo.name}`);
    console.info(`📝 Signature saved to: ${toRelativePath(outputPath)}`);
  } catch (error) {
    console.error("❌ Error signing provider info:", error);
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length !== 2) {
    console.info("Usage:");
    console.info("  yarn sign:provider <path-to-info.json> <private-key>");
    console.info("");
    console.info("Examples:");
    console.info(
      "  yarn sign:provider ./data/providers/eip155-14/provider-name/info.json 0x1234...",
    );
    process.exit(1);
  }

  const [infoPath, privateKey] = args;

  try {
    await signProviderInfo(infoPath, privateKey);
  } catch (error) {
    console.error("❌ Error processing provider info:", error);
  }
}

main().catch(console.error);

export { signProviderInfo };
