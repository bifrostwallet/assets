import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { recoverTypedDataAddress } from "viem";
import {
  BLOCKCHAIN_NETWORKS,
  type BlockchainNetworkConfig,
  DAPP_CATEGORIES,
  DAPP_CHAIN_IDS,
  type DappCategory,
  type DappInfo,
  type ProviderInfo,
} from "./config.js";
import {
  calculateHash,
  dappSlugFromUrl,
  providerInfoMessageHash,
  providerLogoPath,
  rebuildProvidersAllJson,
  sortDappInfo,
  sortProviderInfo,
  toRelativePath,
} from "./convert.js";
import {
  chainIdFromProviderPath,
  dappListingTypedData,
  providerListingTypedData,
} from "./eip712.js";
import { PROVIDER_VERIFICATION_INSTRUCTIONS } from "./intakeGuard.js";
import { fetchEntityData } from "./onchain.js";
import {
  isValidDescription,
  isValidEvmAddress,
  isValidImage,
  isValidName,
  isValidURL,
} from "./validate.js";
import {
  isQualifiedAttester,
  type SignatureEntry,
  type SignaturesData,
  verifyProviderSignatures,
} from "./verify.js";

export interface IngestResult {
  status: "ingested" | "unchanged";
  networkPath: string;
  identityAddress: string;
  infoPath: string;
  selfSigned: boolean;
}

/** Resolves the network from an explicit chainPath (e.g. "eip155-14") */
export function networkFromChainPath(chainPath: string): BlockchainNetworkConfig {
  const network = Object.values(BLOCKCHAIN_NETWORKS).find(
    (candidate) => candidate.path === chainPath && candidate.entityManager,
  );
  if (!network) {
    throw new Error(`Unknown or unsupported chainPath: ${chainPath}`);
  }
  return network;
}

/**
 * Ingests a provider submission directory containing info.json, logo.webp and
 * signatures.json (as produced by the web signing app).
 *
 * Fully non-interactive. Validation pipeline:
 * 1. required files + identity address + logo requirements
 * 2. canonical values enforced (relative logoURL, recomputed logoHash, lowercased identity)
 * 3. on-chain entity data re-fetched from the EntityManager and applied
 * 4. cryptographic signature verification over the FINAL content — if on-chain
 *    data drifted from what the provider signed, ingestion fails and the
 *    provider must re-sign
 *
 * Curator-managed flags (listed, managementGroup, domainLinked) are preserved
 * from an existing repo entry and never taken from the submission.
 *
 * Idempotent: re-ingesting a submission that matches the repo state returns
 * "unchanged" without touching files.
 */
export async function ingestProviderSubmission(
  sourceDir: string,
  options: { chainPath?: string } = {},
): Promise<IngestResult> {
  for (const required of ["info.json", "logo.webp", "signatures.json"]) {
    if (!fs.existsSync(path.join(sourceDir, required))) {
      throw new Error(`Submission is missing ${required}`);
    }
  }

  const submitted = JSON.parse(
    fs.readFileSync(path.join(sourceDir, "info.json"), "utf8"),
  ) as ProviderInfo & { chainPath?: string };

  if (!isValidEvmAddress(submitted.identityAddress)) {
    throw new Error(`Invalid identity address in submission: ${submitted.identityAddress}`);
  }
  if (!isValidName(submitted.name)) {
    throw new Error(`Invalid provider name: ${submitted.name}`);
  }
  if (!isValidDescription(submitted.description)) {
    throw new Error("Invalid provider description");
  }
  if (!isValidURL(submitted.websiteURL, "website")) {
    throw new Error(`Invalid websiteURL: ${submitted.websiteURL}`);
  }

  const chainPath = options.chainPath ?? submitted.chainPath;
  if (!chainPath) {
    throw new Error("Submission does not declare a chainPath and none was provided");
  }
  const network = networkFromChainPath(chainPath);
  const identity = submitted.identityAddress.toLowerCase();

  const logoValidation = isValidImage(path.join(sourceDir, "logo.webp"));
  if (!logoValidation.isValid) {
    throw new Error(`Logo validation failed: ${logoValidation.errors.join(", ")}`);
  }

  const existingDir = path.join(process.cwd(), "data", "providers", network.path, identity);
  const existingInfo: ProviderInfo | null = fs.existsSync(path.join(existingDir, "info.json"))
    ? (JSON.parse(fs.readFileSync(path.join(existingDir, "info.json"), "utf8")) as ProviderInfo)
    : null;

  // Canonical values: relative logo path, recomputed hash, curator flags from repo state
  const { chainPath: _ignored, ...submittedInfo } = submitted;
  const info: Partial<ProviderInfo> = {
    ...submittedInfo,
    identityAddress: identity,
    logoURL: providerLogoPath(network.path, identity),
    logoHash: calculateHash(path.join(sourceDir, "logo.webp")),
    listed: existingInfo?.listed ?? false,
    managementGroup: existingInfo?.managementGroup ?? false,
    domainLinked: existingInfo?.domainLinked ?? false,
    dualNetwork: existingInfo?.dualNetwork ?? false,
  };
  if (existingInfo?.firstTransaction) {
    info.firstTransaction = existingInfo.firstTransaction;
  }

  // On-chain entity data is authoritative
  const onchain = await fetchEntityData(identity, network);
  Object.assign(info, onchain);

  // Verify the signature against the final content in a staging directory
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-provider-staging-"));
  const finalInfoJson = `${JSON.stringify(sortProviderInfo(info), null, 2)}\n`;
  fs.writeFileSync(path.join(stagingDir, "info.json"), finalInfoJson);
  fs.copyFileSync(
    path.join(sourceDir, "signatures.json"),
    path.join(stagingDir, "signatures.json"),
  );

  const verification = await verifyProviderSignatures(
    stagingDir,
    true,
    chainIdFromProviderPath(chainPath),
  );
  if (!verification.hasValidSelfSignature) {
    const reasons = verification.invalidSignatures
      .map((invalid) => `${invalid.entry.signerAddress}: ${invalid.reason}`)
      .join("; ");
    throw new Error(
      `No valid self-signature by the identity address over the final info.json (${reasons || "no signatures"}). If on-chain data changed since signing, the provider must re-sign.`,
    );
  }

  // Idempotency: same info content and same signatures already in the repo
  const submittedSignatures = JSON.parse(
    fs.readFileSync(path.join(sourceDir, "signatures.json"), "utf8"),
  ) as SignaturesData;

  const sourceProvenancePath = path.join(sourceDir, "provenance.json");
  const provenanceJson = fs.existsSync(sourceProvenancePath)
    ? fs.readFileSync(sourceProvenancePath, "utf8")
    : null;
  const destProvenancePath = path.join(existingDir, "provenance.json");
  // Legacy private contact file — remove if present so it is never committed once the repo is public
  const legacySubmissionPath = path.join(existingDir, "submission.json");

  if (existingInfo) {
    const existingInfoJson = fs.readFileSync(path.join(existingDir, "info.json"), "utf8");
    const existingSignaturesPath = path.join(existingDir, "signatures.json");
    const existingSignatureHexes = fs.existsSync(existingSignaturesPath)
      ? new Set(
          (
            JSON.parse(fs.readFileSync(existingSignaturesPath, "utf8")) as SignaturesData
          ).signatures.map((entry) => entry.signature.toLowerCase()),
        )
      : new Set<string>();

    const allSignaturesKnown = submittedSignatures.signatures.every((entry) =>
      existingSignatureHexes.has(entry.signature.toLowerCase()),
    );
    const provenanceUnchanged =
      !provenanceJson ||
      (fs.existsSync(destProvenancePath) &&
        fs.readFileSync(destProvenancePath, "utf8") === provenanceJson);

    if (
      existingInfoJson === finalInfoJson &&
      allSignaturesKnown &&
      provenanceUnchanged &&
      !fs.existsSync(legacySubmissionPath)
    ) {
      return {
        status: "unchanged",
        networkPath: network.path,
        identityAddress: identity,
        infoPath: path.join(existingDir, "info.json"),
        selfSigned: verification.hasValidSelfSignature,
      };
    }
  }

  // Write files and rebuild the chain aggregate
  fs.mkdirSync(existingDir, { recursive: true });
  fs.writeFileSync(path.join(existingDir, "info.json"), finalInfoJson);
  fs.copyFileSync(path.join(sourceDir, "logo.webp"), path.join(existingDir, "logo.webp"));
  fs.writeFileSync(
    path.join(existingDir, "signatures.json"),
    `${JSON.stringify(submittedSignatures, null, 2)}\n`,
  );
  if (provenanceJson) {
    fs.writeFileSync(destProvenancePath, provenanceJson);
  }
  if (fs.existsSync(legacySubmissionPath)) {
    fs.unlinkSync(legacySubmissionPath);
  }
  rebuildProvidersAllJson(network.path);

  console.info(`📁 Ingested provider ${info.name} at ${toRelativePath(existingDir)}`);

  return {
    status: "ingested",
    networkPath: network.path,
    identityAddress: identity,
    infoPath: path.join(existingDir, "info.json"),
    selfSigned: verification.hasValidSelfSignature,
  };
}

/**
 * A submission document as stored in the intake bucket by the intake service
 * (apps/intake) and consumed by pull:submissions.
 */
export interface IntakeSubmission {
  version: 1;
  chainPath: string;
  info: ProviderInfo;
  signatures: SignaturesData;
  /** Base64-encoded WebP */
  logoBase64: string;
  submittedAt: string;
}

/**
 * Public, non-PII provenance only. Outreach / sealed forensics stay outside git
 * (sealed bucket + unseal CLI).
 */
function publicProvenanceRecord(submission: {
  submittedAt: string;
  submitter?: string;
  messageHash?: string;
  signature?: string;
}): Record<string, string> {
  const record: Record<string, string> = {
    submittedAt: submission.submittedAt,
  };
  if (submission.submitter) record.submitter = submission.submitter;
  if (submission.messageHash) record.messageHash = submission.messageHash;
  if (submission.signature) record.signature = submission.signature;
  return record;
}

/** Materializes an intake submission document into a temp submission directory */
export function intakeSubmissionToDir(submission: IntakeSubmission): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-ingest-"));
  fs.writeFileSync(
    path.join(dir, "info.json"),
    JSON.stringify({ ...submission.info, chainPath: submission.chainPath }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, "signatures.json"),
    JSON.stringify(submission.signatures, null, 2),
  );
  fs.writeFileSync(path.join(dir, "logo.webp"), Buffer.from(submission.logoBase64, "base64"));
  fs.writeFileSync(
    path.join(dir, "provenance.json"),
    `${JSON.stringify(publicProvenanceRecord({ submittedAt: submission.submittedAt }), null, 2)}\n`,
  );
  return dir;
}

/**
 * An attestation document as stored in the intake bucket by the intake service
 * under attestations/<chain>/<target>/<attester>.json: one provider signing
 * another provider's current entry through the web app.
 */
export interface IntakeAttestation {
  chainPath: string;
  targetIdentityAddress: string;
  attestation: {
    signerName: string;
    signerAddress: string;
    messageHash: string;
    signature: string;
    date: string;
  };
  submittedAt: string;
}

export interface AttestationIngestResult {
  status: "ingested" | "unchanged";
  targetIdentityAddress: string;
  signerAddress: string;
}

/**
 * Verifies and merges a web-app attestation into the target provider's
 * signatures.json.
 *
 * Validation pipeline:
 * 1. the target entry exists and the attested messageHash matches the SHA-256
 *    of its CURRENT signed info.json payload — stale attestations are rejected
 * 2. the signature cryptographically recovers to the declared attester address
 * 3. the attester qualifies: their own entry on the same chain is listed and
 *    self-signed (the same gate verification applies when counting attestations)
 *
 * Idempotent: an attestation already present in signatures.json returns
 * "unchanged" without touching files.
 */
export async function ingestProviderAttestation(
  doc: IntakeAttestation,
): Promise<AttestationIngestResult> {
  const { chainPath, targetIdentityAddress, attestation } = doc;
  const signer = attestation.signerAddress.toLowerCase();
  if (signer === targetIdentityAddress.toLowerCase()) {
    throw new Error("Self-signatures must go through the listing submission flow");
  }

  const targetDir = path.join(
    process.cwd(),
    "data",
    "providers",
    chainPath,
    targetIdentityAddress.toLowerCase(),
  );
  const infoPath = path.join(targetDir, "info.json");
  if (!fs.existsSync(infoPath)) {
    throw new Error(`Attested provider does not exist: ${chainPath}/${targetIdentityAddress}`);
  }

  const info = JSON.parse(fs.readFileSync(infoPath, "utf8")) as ProviderInfo;
  const expectedHash = providerInfoMessageHash(info);
  if (attestation.messageHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(
      `Stale attestation: expected message hash ${expectedHash}, got ${attestation.messageHash}. The entry changed since signing; the attester must re-attest.`,
    );
  }

  const typed = providerListingTypedData(info, chainIdFromProviderPath(chainPath));
  const recovered = await recoverTypedDataAddress({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
    signature: attestation.signature as `0x${string}`,
  });
  if (recovered.toLowerCase() !== signer) {
    throw new Error(`Recovered signer ${recovered} does not match ${attestation.signerAddress}`);
  }

  if (!(await isQualifiedAttester(targetDir, signer))) {
    throw new Error(
      `Attester ${signer} does not qualify: attesters must be listed and self-signed on ${chainPath}`,
    );
  }

  const signaturesPath = path.join(targetDir, "signatures.json");
  const signaturesData: SignaturesData = fs.existsSync(signaturesPath)
    ? (JSON.parse(fs.readFileSync(signaturesPath, "utf8")) as SignaturesData)
    : {
        identityAddress: targetIdentityAddress.toLowerCase(),
        verificationInstructions: PROVIDER_VERIFICATION_INSTRUCTIONS,
        signatures: [],
      };

  const entry: SignatureEntry = {
    signerName: attestation.signerName,
    signerAddress: attestation.signerAddress as SignatureEntry["signerAddress"],
    messageHash: attestation.messageHash,
    signature: attestation.signature as SignatureEntry["signature"],
    date: attestation.date,
  };

  const existingIndex = signaturesData.signatures.findIndex(
    (existing) => existing.signerAddress.toLowerCase() === signer,
  );
  if (existingIndex >= 0) {
    const existing = signaturesData.signatures[existingIndex];
    if (existing.signature.toLowerCase() === attestation.signature.toLowerCase()) {
      return {
        status: "unchanged",
        targetIdentityAddress: targetIdentityAddress.toLowerCase(),
        signerAddress: signer,
      };
    }
    signaturesData.signatures[existingIndex] = entry;
  } else {
    if (signaturesData.signatures.length >= 8) {
      throw new Error("signatures.json already holds the maximum of 8 signatures");
    }
    signaturesData.signatures.push(entry);
  }

  fs.writeFileSync(signaturesPath, `${JSON.stringify(signaturesData, null, 2)}\n`);
  console.info(
    `🖋 Attestation by ${attestation.signerName} (${signer}) merged into ${toRelativePath(signaturesPath)}`,
  );

  return {
    status: "ingested",
    targetIdentityAddress: targetIdentityAddress.toLowerCase(),
    signerAddress: signer,
  };
}

/**
 * A dapp submission document as stored in the intake bucket by the intake
 * service (apps/intake) under dapps/<submitter>/<slug>.json.
 */
export interface IntakeDappSubmission {
  version: 1;
  kind: "dapp";
  info: {
    title: string;
    description: string;
    url: string;
    chains: string[];
    category: string;
  };
  /** Bound in EIP-712 + contentHash when category is `other`; never written to catalog info.json. */
  categoryOther?: string;
  submitter: string;
  messageHash: string;
  signature: string;
  /** Base64-encoded WebP */
  logoBase64: string;
  submittedAt: string;
}

export interface DappIngestResult {
  status: "ingested" | "unchanged";
  slug: string;
  infoPath: string;
}

/** CAIP-2 chain ids allowed for dapp bookmarks */
const DAPP_ALLOWED_CHAINS = new Set<string>(DAPP_CHAIN_IDS);

/**
 * Ingests a dapp submission document into data/dapps/<slug>.
 *
 * Fully non-interactive. Validation pipeline:
 * 1. field validation with the repository validators
 * 2. logo requirements (exact 128×128 WebP, ≤24KB; transparent background
 *    recommended, opaque including solid white still valid)
 * 3. cryptographic verification: the submitter signed the canonical hash of
 *    the submitted content including the recomputed logo hash
 *
 * The curator-managed featured flag is preserved from an existing repo entry
 * and never taken from the submission. Public provenance (submitter signature)
 * is stored as provenance.json — sealed outreach is not pulled or committed.
 *
 * Idempotent: re-ingesting a submission that matches the repo state returns
 * "unchanged" without touching files.
 */
export async function ingestDappSubmission(
  submission: IntakeDappSubmission,
): Promise<DappIngestResult> {
  const { title, description, url, chains, category } = submission.info;

  if (!isValidName(title)) {
    throw new Error(`Invalid dapp title: ${title}`);
  }
  if (!isValidDescription(description)) {
    throw new Error("Invalid dapp description");
  }
  if (!isValidURL(url, "website")) {
    throw new Error(`Invalid dapp URL: ${url}`);
  }
  if (
    !Array.isArray(chains) ||
    chains.length === 0 ||
    !chains.every((chain) => DAPP_ALLOWED_CHAINS.has(chain))
  ) {
    throw new Error(`Invalid dapp chains: ${JSON.stringify(chains)}`);
  }
  if (!(DAPP_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`Unknown dapp category: ${category}`);
  }
  if (!isValidEvmAddress(submission.submitter)) {
    throw new Error(`Invalid submitter address: ${submission.submitter}`);
  }

  const logo = Buffer.from(submission.logoBase64, "base64");
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-dapp-staging-"));
  const stagedLogoPath = path.join(stagingDir, "logo.webp");
  fs.writeFileSync(stagedLogoPath, logo);

  const logoValidation = isValidImage(stagedLogoPath);
  if (!logoValidation.isValid) {
    throw new Error(`Logo validation failed: ${logoValidation.errors.join(", ")}`);
  }

  // Verify the submitter's EIP-712 signature over the listing typed data
  const logoHash = calculateHash(stagedLogoPath);
  const typed = dappListingTypedData({
    title,
    description,
    url,
    chains,
    category,
    categoryOther: submission.categoryOther ?? "",
    logoHash,
  });
  if (submission.messageHash?.toLowerCase() !== typed.contentHash.toLowerCase()) {
    throw new Error(
      `Stale message hash: expected ${typed.contentHash}, got ${submission.messageHash}`,
    );
  }
  const recovered = await recoverTypedDataAddress({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
    signature: submission.signature as `0x${string}`,
  });
  if (recovered.toLowerCase() !== submission.submitter.toLowerCase()) {
    throw new Error(`Recovered signer ${recovered} does not match ${submission.submitter}`);
  }

  const slug = dappSlugFromUrl(url);
  const dappDir = path.join(process.cwd(), "data", "dapps", slug);
  const infoPath = path.join(dappDir, "info.json");

  const existingInfo: DappInfo | null = fs.existsSync(infoPath)
    ? (JSON.parse(fs.readFileSync(infoPath, "utf8")) as DappInfo)
    : null;

  const info = sortDappInfo({
    title,
    description,
    url,
    logoURL: `dapps/${slug}/logo.webp`,
    logoHash,
    chains: [...chains].sort(),
    category: category as DappCategory,
    featured: existingInfo?.featured ?? false,
  });
  const finalInfoJson = `${JSON.stringify(info, null, 2)}\n`;

  const provenanceJson = `${JSON.stringify(
    publicProvenanceRecord({
      submittedAt: submission.submittedAt,
      submitter: submission.submitter.toLowerCase(),
      messageHash: typed.contentHash,
      signature: submission.signature,
    }),
    null,
    2,
  )}\n`;
  const provenancePath = path.join(dappDir, "provenance.json");
  const legacySubmissionPath = path.join(dappDir, "submission.json");

  if (
    existingInfo &&
    fs.readFileSync(infoPath, "utf8") === finalInfoJson &&
    fs.existsSync(provenancePath) &&
    fs.readFileSync(provenancePath, "utf8") === provenanceJson &&
    !fs.existsSync(legacySubmissionPath)
  ) {
    return { status: "unchanged", slug, infoPath };
  }

  fs.mkdirSync(dappDir, { recursive: true });
  fs.writeFileSync(infoPath, finalInfoJson);
  fs.writeFileSync(path.join(dappDir, "logo.webp"), logo);
  fs.writeFileSync(provenancePath, provenanceJson);
  if (fs.existsSync(legacySubmissionPath)) {
    fs.unlinkSync(legacySubmissionPath);
  }

  console.info(`📁 Ingested dapp ${title} at ${toRelativePath(dappDir)}`);

  return { status: "ingested", slug, infoPath };
}
