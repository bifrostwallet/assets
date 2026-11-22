import * as fs from "node:fs";
import * as path from "node:path";
import { recoverTypedDataAddress } from "viem";
import type { ProviderInfo } from "./config.js";
import { providerInfoMessageHash } from "./convert.js";
import { chainIdFromProviderPath, providerListingTypedDataForEntry } from "./eip712.js";
import type { HexString } from "./validate.js";

export interface SignatureEntry {
  signerName: string;
  signerAddress: HexString;
  messageHash: string;
  signature: HexString;
  /** Signed in version 2 (as signedAt); not signed in version 1. */
  date: string;
  /** 2 for version 2 typed data; absent for version 1. */
  version?: 2;
  /** Version 2 only. */
  nonce?: string;
  /** Version 2 only. */
  sealedHash?: string;
}

export interface SignaturesData {
  identityAddress: string;
  verificationInstructions: string;
  signatures: SignatureEntry[];
}

export interface ProviderSignatureVerification {
  providerDir: string;
  identityAddress: string;
  hasSignaturesFile: boolean;
  expectedMessageHash: string;
  validSignatures: SignatureEntry[];
  invalidSignatures: { entry: SignatureEntry; reason: string }[];
  hasValidSelfSignature: boolean;
}

/**
 * Cryptographically verifies signatures.json for a provider directory.
 *
 * A signature is valid when:
 * - its messageHash equals the SHA-256 contentHash of the current signed info.json
 *   payload (curator fields like listed/managementGroup/domainLinked and logoURL
 *   are excluded), and
 * - recovering the signer via EIP-712 ProviderListing typed data yields signerAddress,
 *   using the entry's version: version 2 also signs its date, nonce and sealedHash.
 *
 * signatures.json holds exactly one entry: the provider's own signature, by its
 * identity address. An entry by any other address, or a second entry, is
 * invalid.
 *
 * `chainId` is required when `providerDir` is not under an `eip155-<id>` path.
 * Intake ingest verifies a copy in a temporary directory and passes the chain
 * id from the submission instead of the temp path.
 */
export async function verifyProviderSignatures(
  providerDir: string,
  chainId = chainIdFromProviderPath(providerDir),
): Promise<ProviderSignatureVerification> {
  const infoPath = path.join(providerDir, "info.json");
  const signaturesPath = path.join(providerDir, "signatures.json");

  const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
  const expectedMessageHash = providerInfoMessageHash(info);

  const result: ProviderSignatureVerification = {
    providerDir,
    identityAddress: info.identityAddress,
    hasSignaturesFile: fs.existsSync(signaturesPath),
    expectedMessageHash,
    validSignatures: [],
    invalidSignatures: [],
    hasValidSelfSignature: false,
  };

  if (!result.hasSignaturesFile) {
    return result;
  }

  const signaturesData = JSON.parse(fs.readFileSync(signaturesPath, "utf8")) as SignaturesData;

  const identity = info.identityAddress.toLowerCase();
  for (const [index, entry] of (signaturesData.signatures ?? []).entries()) {
    if (entry.signerAddress?.toLowerCase() !== identity) {
      result.invalidSignatures.push({
        entry,
        reason: "Only the provider's own signature (by its identity address) is accepted",
      });
      continue;
    }
    if (index > 0) {
      result.invalidSignatures.push({ entry, reason: "signatures.json holds one signature only" });
      continue;
    }
    if (entry.messageHash?.toLowerCase() !== expectedMessageHash.toLowerCase()) {
      result.invalidSignatures.push({
        entry,
        reason: `Stale message hash: expected ${expectedMessageHash}, got ${entry.messageHash}`,
      });
      continue;
    }

    let typed: ReturnType<typeof providerListingTypedDataForEntry>;
    try {
      typed = providerListingTypedDataForEntry(info, chainId, entry);
    } catch (error) {
      result.invalidSignatures.push({
        entry,
        reason: error instanceof Error ? error.message : "Unsupported signature entry",
      });
      continue;
    }

    let recovered: string;
    try {
      recovered = await recoverTypedDataAddress({
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
        signature: entry.signature,
      });
    } catch {
      result.invalidSignatures.push({
        entry,
        reason: "Signature recovery failed",
      });
      continue;
    }

    if (recovered.toLowerCase() !== entry.signerAddress.toLowerCase()) {
      result.invalidSignatures.push({
        entry,
        reason: `Recovered signer ${recovered} does not match declared ${entry.signerAddress}`,
      });
      continue;
    }

    result.validSignatures.push(entry);
    result.hasValidSelfSignature = true;
  }

  return result;
}

/**
 * Finds all provider directories (containing info.json) under data/providers
 */
export function findProviderDirs(providersDir = path.join(process.cwd(), "data", "providers")) {
  const dirs: string[] = [];
  if (!fs.existsSync(providersDir)) {
    return dirs;
  }

  for (const chain of fs.readdirSync(providersDir, { withFileTypes: true })) {
    if (!chain.isDirectory()) continue;
    const chainDir = path.join(providersDir, chain.name);
    for (const provider of fs.readdirSync(chainDir, { withFileTypes: true })) {
      if (!provider.isDirectory()) continue;
      const providerDir = path.join(chainDir, provider.name);
      if (fs.existsSync(path.join(providerDir, "info.json"))) {
        dirs.push(providerDir);
      }
    }
  }

  return dirs;
}
