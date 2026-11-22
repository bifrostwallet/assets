import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BLOCKCHAIN_NETWORKS, type BlockchainNetworkConfig, type ProviderInfo } from "./config.js";
import {
  calculateHash,
  formatRepoJson,
  providerLogoPath,
  rebuildProvidersAllJson,
  sortProviderInfo,
  toRelativePath,
  writeFormattedJson,
} from "./convert.js";
import { chainIdFromProviderPath } from "./eip712.js";
import { fetchEntityData } from "./onchain.js";
import {
  isValidDescription,
  isValidEvmAddress,
  isValidImage,
  isValidName,
  isValidURL,
} from "./validate.js";
import { type SignatureEntry, type SignaturesData, verifyProviderSignatures } from "./verify.js";

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

function websiteHost(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function sameWebsiteHost(a: string | undefined, b: string | undefined): boolean {
  const host = websiteHost(a);
  return host !== "" && host === websiteHost(b);
}

/** True when `filePath` exists and its bytes equal `bytes`. */
function fileBytesEqual(filePath: string, bytes: Buffer): boolean {
  return fs.existsSync(filePath) && fs.readFileSync(filePath).equals(bytes);
}

/**
 * True when the catalog info.json and logo.webp are byte-identical to the
 * listing ingest would write. A resubmission in that state must keep the
 * existing provenance.json so submittedAt alone does not dirty the tree.
 */
function listingContentUnchanged(
  infoPath: string,
  infoJson: string,
  logoPath: string,
  logo: Buffer,
): boolean {
  return fileBytesEqual(infoPath, Buffer.from(infoJson)) && fileBytesEqual(logoPath, logo);
}

function newestSelfSignatureMs(
  entries: readonly SignatureEntry[],
  identity: string,
): number | null {
  let newest: number | null = null;
  for (const entry of entries) {
    if (entry.signerAddress.toLowerCase() !== identity) continue;
    const ms = Date.parse(entry.date);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

/**
 * Refuses a new self-signature (one not already on main) that is not dated
 * after the newest published self-signature. Re-sending the published
 * self-signature, for example next to a new co-signature, is not a rollback.
 */
export function assertNewerSelfSignature(
  identity: string,
  submitted: readonly SignatureEntry[],
  publishedSignaturesPath: string,
): void {
  if (!fs.existsSync(publishedSignaturesPath)) return;
  const published = JSON.parse(fs.readFileSync(publishedSignaturesPath, "utf8")) as SignaturesData;
  const publishedEntries = published.signatures ?? [];
  const publishedHexes = new Set(publishedEntries.map((entry) => entry.signature.toLowerCase()));
  const fresh = submitted.filter((entry) => !publishedHexes.has(entry.signature.toLowerCase()));
  const publishedMs = newestSelfSignatureMs(publishedEntries, identity.toLowerCase());
  const submittedMs = newestSelfSignatureMs(fresh, identity.toLowerCase());
  if (publishedMs === null || submittedMs === null) return;
  if (submittedMs <= publishedMs) {
    throw new Error(
      `Self-signature dated ${new Date(submittedMs).toISOString()} is not newer than the published one (${new Date(publishedMs).toISOString()}); refusing a rollback.`,
    );
  }
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
 * Curator-managed flags (listed, domainLinked) are preserved from an existing
 * repo entry and never taken from the submission. managementGroup is read from
 * that network's PollingManagementGroup, including on a resubmission, and is
 * not taken from the submission or defaulted to false.
 *
 * Idempotent: re-ingesting a submission whose info.json, logo, and signatures
 * already match the repo returns "unchanged" without touching files. When
 * info.json and the logo are byte-identical, the existing provenance.json is
 * left in place so a new submittedAt does not change the catalog by itself.
 */
export async function ingestProviderSubmission(
  sourceDir: string,
  options: {
    chainPath?: string;
    /**
     * EntityManager reader. Defaults to the on-chain lookup. Tests pass a
     * stub so the resubmission check does not depend on a network.
     */
    readEntityData?: typeof fetchEntityData;
  } = {},
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

  // Canonical values: relative logo path, recomputed hash, curator flags from repo state.
  // managementGroup is not copied from the submission; the chain read sets it.
  const {
    chainPath: _ignored,
    managementGroup: _submittedManagementGroup,
    ...submittedInfo
  } = submitted;
  const info: Partial<ProviderInfo> = {
    ...submittedInfo,
    identityAddress: identity,
    logoURL: providerLogoPath(network.path, identity),
    logoHash: calculateHash(path.join(sourceDir, "logo.webp")),
    listed: existingInfo?.listed ?? false,
    domainLinked: sameWebsiteHost(existingInfo?.websiteURL, submitted.websiteURL)
      ? (existingInfo?.domainLinked ?? false)
      : false,
    dualNetwork: existingInfo?.dualNetwork ?? false,
  };
  if (existingInfo?.firstTransaction) {
    info.firstTransaction = existingInfo.firstTransaction;
  }

  // On-chain entity data is authoritative, including Management Group membership.
  const readEntityData =
    options.readEntityData ??
    ((identityAddress: string, entityNetwork: BlockchainNetworkConfig) =>
      fetchEntityData(identityAddress, entityNetwork, { includeManagementGroup: true }));
  const onchain = await readEntityData(identity, network);
  Object.assign(info, onchain);
  if (typeof onchain.managementGroup !== "boolean") {
    throw new Error(`managementGroup was not read from chain for ${identity} on ${network.path}`);
  }
  info.managementGroup = onchain.managementGroup;

  // Verify the signature against the final content in a staging directory
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-provider-staging-"));
  const infoPath = path.join(existingDir, "info.json");
  const finalInfoJson = formatRepoJson(sortProviderInfo(info), infoPath);
  fs.writeFileSync(path.join(stagingDir, "info.json"), finalInfoJson);
  fs.copyFileSync(
    path.join(sourceDir, "signatures.json"),
    path.join(stagingDir, "signatures.json"),
  );

  const verification = await verifyProviderSignatures(
    stagingDir,
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

  // A tampered or replayed entry (stale message hash, a signature that does not
  // recover to its declared signer) is never written to the catalog. The whole
  // submission is refused, so one bad provider fails alone (pull:submissions
  // logs it and moves on to the next object).
  if (verification.invalidSignatures.length > 0) {
    const reasons = verification.invalidSignatures
      .map((invalid) => `${invalid.entry.signerAddress}: ${invalid.reason}`)
      .join("; ");
    throw new Error(`Refusing submission with invalid signature entries (${reasons}).`);
  }

  // Idempotency: identical info, logo, and signatures. Provenance is preserved
  // when info.json and the logo are byte-identical, even if submittedAt differs.
  // Only entries that passed verification are written, never the raw submission.
  const submittedSignatures: SignaturesData = {
    ...(JSON.parse(
      fs.readFileSync(path.join(sourceDir, "signatures.json"), "utf8"),
    ) as SignaturesData),
    signatures: verification.validSignatures,
  };

  const sourceProvenancePath = path.join(sourceDir, "provenance.json");
  const provenanceJson = fs.existsSync(sourceProvenancePath)
    ? fs.readFileSync(sourceProvenancePath, "utf8")
    : null;
  const destProvenancePath = path.join(existingDir, "provenance.json");
  const logoBytes = fs.readFileSync(path.join(sourceDir, "logo.webp"));
  const contentUnchanged = listingContentUnchanged(
    infoPath,
    finalInfoJson,
    path.join(existingDir, "logo.webp"),
    logoBytes,
  );
  // Identical info.json + logo: do not bump provenance submittedAt.
  const preserveProvenance = contentUnchanged && fs.existsSync(destProvenancePath);

  if (existingInfo) {
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
      preserveProvenance ||
      !provenanceJson ||
      (fs.existsSync(destProvenancePath) &&
        fs.readFileSync(destProvenancePath, "utf8") === provenanceJson);

    if (contentUnchanged && allSignaturesKnown && provenanceUnchanged) {
      return {
        status: "unchanged",
        networkPath: network.path,
        identityAddress: identity,
        infoPath,
        selfSigned: verification.hasValidSelfSignature,
      };
    }
  }

  // Rollback guard: a new self-signature must be dated after the newest one on
  // main. Version 2 signs the date, so an old signature cannot pass by editing
  // it, and no git history is needed. Re-pulling an already ingested object is
  // handled above as unchanged.
  assertNewerSelfSignature(
    identity,
    submittedSignatures.signatures,
    path.join(existingDir, "signatures.json"),
  );

  // Write files and rebuild the chain aggregate
  fs.mkdirSync(existingDir, { recursive: true });
  fs.writeFileSync(infoPath, finalInfoJson);
  fs.writeFileSync(path.join(existingDir, "logo.webp"), logoBytes);
  writeFormattedJson(path.join(existingDir, "signatures.json"), submittedSignatures);
  if (provenanceJson && !preserveProvenance) {
    fs.writeFileSync(destProvenancePath, provenanceJson);
  }
  rebuildProvidersAllJson(network.path);

  console.info(`📁 Ingested provider ${info.name} at ${toRelativePath(existingDir)}`);

  return {
    status: "ingested",
    networkPath: network.path,
    identityAddress: identity,
    infoPath,
    selfSigned: verification.hasValidSelfSignature,
  };
}

/**
 * A submission document as stored in the intake bucket by the intake service
 * and consumed by pull:submissions.
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
function publicProvenanceRecord(submittedAt: string): Record<string, string> {
  return { submittedAt };
}

/** Materializes an intake submission document into a temp submission directory */
export function intakeSubmissionToDir(submission: IntakeSubmission): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-ingest-"));
  writeFormattedJson(path.join(dir, "info.json"), {
    ...submission.info,
    chainPath: submission.chainPath,
  });
  writeFormattedJson(path.join(dir, "signatures.json"), submission.signatures);
  fs.writeFileSync(path.join(dir, "logo.webp"), Buffer.from(submission.logoBase64, "base64"));
  // Copied into the catalog unless info.json and the logo already match.
  writeFormattedJson(
    path.join(dir, "provenance.json"),
    publicProvenanceRecord(submission.submittedAt),
  );
  return dir;
}
