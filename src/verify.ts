import * as fs from "node:fs";
import * as path from "node:path";
import { recoverTypedDataAddress } from "viem";
import type { ProviderInfo } from "./config.js";
import { providerInfoMessageHash } from "./convert.js";
import { chainIdFromProviderPath, providerListingTypedData } from "./eip712.js";
import type { HexString } from "./validate.js";

export interface SignatureEntry {
  signerName: string;
  signerAddress: HexString;
  messageHash: string;
  signature: HexString;
  date: string;
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
  hasValidSignature: boolean;
  hasValidSelfSignature: boolean;
  /**
   * A valid signature from a qualifying attester: a provider entry on the same
   * chain that is `listed` and carries a valid self-signature of its own.
   * Additional confirmation only — never a substitute for the self-signature.
   */
  hasValidAttestation: boolean;
}

/**
 * Cryptographically verifies signatures.json for a provider directory.
 *
 * A signature is valid when:
 * - its messageHash equals the SHA-256 contentHash of the current signed info.json
 *   payload (curator fields like listed/managementGroup/domainLinked and logoURL
 *   are excluded), and
 * - recovering the signer via EIP-712 ProviderListing typed data yields signerAddress.
 *
 * A valid signature from the provider's own identity address is a self-signature
 * and is what satisfies the repository's signature requirement. Any other valid
 * signature is an attestation — additional confirmation that another provider
 * verified the entry. An attestation only counts as such when the attester's own
 * entry (sibling directory on the same chain) is `listed` and self-signed.
 *
 * `resolveAttesters` is internal: attester lookups verify the attester's own
 * entry with it disabled, so attestation chains never recurse.
 *
 * `chainId` is required when `providerDir` is not under an `eip155-<id>` path.
 * Intake ingest verifies a copy in a temporary directory and passes the chain
 * id from the submission instead of the temp path.
 */
export async function verifyProviderSignatures(
  providerDir: string,
  resolveAttesters = true,
  chainId = chainIdFromProviderPath(providerDir),
): Promise<ProviderSignatureVerification> {
  const infoPath = path.join(providerDir, "info.json");
  const signaturesPath = path.join(providerDir, "signatures.json");

  const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
  const expectedMessageHash = providerInfoMessageHash(info);
  const typed = providerListingTypedData(info, chainId);

  const result: ProviderSignatureVerification = {
    providerDir,
    identityAddress: info.identityAddress,
    hasSignaturesFile: fs.existsSync(signaturesPath),
    expectedMessageHash,
    validSignatures: [],
    invalidSignatures: [],
    hasValidSignature: false,
    hasValidSelfSignature: false,
    hasValidAttestation: false,
  };

  if (!result.hasSignaturesFile) {
    return result;
  }

  const signaturesData = JSON.parse(fs.readFileSync(signaturesPath, "utf8")) as SignaturesData;

  for (const entry of signaturesData.signatures ?? []) {
    if (entry.messageHash?.toLowerCase() !== expectedMessageHash.toLowerCase()) {
      result.invalidSignatures.push({
        entry,
        reason: `Stale message hash: expected ${expectedMessageHash}, got ${entry.messageHash}`,
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
    if (entry.signerAddress.toLowerCase() === info.identityAddress.toLowerCase()) {
      result.hasValidSelfSignature = true;
    }
  }

  result.hasValidSignature = result.validSignatures.length > 0;

  if (resolveAttesters && !result.hasValidSelfSignature) {
    for (const entry of result.validSignatures) {
      if (await isQualifiedAttester(providerDir, entry.signerAddress)) {
        result.hasValidAttestation = true;
        break;
      }
    }
  }

  return result;
}

/**
 * An attester qualifies when their own entry — the sibling provider directory
 * for the signer address on the same chain — is `listed` and self-signed.
 */
export async function isQualifiedAttester(
  providerDir: string,
  signerAddress: string,
): Promise<boolean> {
  const attesterDir = path.join(path.dirname(providerDir), signerAddress.toLowerCase());
  const attesterInfoPath = path.join(attesterDir, "info.json");
  if (!fs.existsSync(attesterInfoPath)) {
    return false;
  }

  const attesterInfo = JSON.parse(fs.readFileSync(attesterInfoPath, "utf8")) as ProviderInfo;
  if (attesterInfo.listed !== true) {
    return false;
  }

  const attesterResult = await verifyProviderSignatures(attesterDir, false);
  return attesterResult.hasValidSelfSignature;
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
