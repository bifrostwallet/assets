import { createHash } from "node:crypto";
import {
  ALLOWED_LINKS,
  DAPP_CATEGORIES,
  DAPP_CHAIN_IDS,
  PROVIDER_INFO_KEYS,
  PROVIDER_LOGO_REQUIREMENTS,
} from "./config.js";
import { PROVIDER_VERIFICATION_INSTRUCTIONS } from "./eip712.js";
import {
  isValidDescription,
  isValidEvmAddress,
  isValidName,
  isValidNodeID,
  isValidPublicKey,
  isValidURL,
} from "./validate.js";
import { isWebpMagic, readWebpDimensions } from "./webp.js";

export { PROVIDER_VERIFICATION_INSTRUCTIONS };

const MAX_INTAKE_OBJECT_BYTES = 256 * 1024;
const MAX_LOGO_BASE64_CHARS = 40_000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MESSAGE_HASH_RE = /^0x[0-9a-f]{64}$/;
const SIG_HEX_RE = /^0x[0-9a-fA-F]{130}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DAPP_ALLOWED_CHAINS = new Set<string>(DAPP_CHAIN_IDS);

const PROVIDER_DOC_KEYS = new Set([
  "version",
  "kind",
  "chainPath",
  "info",
  "signatures",
  "logoBase64",
  "submittedAt",
]);
const DAPP_DOC_KEYS = new Set([
  "version",
  "kind",
  "info",
  "categoryOther",
  "submitter",
  "messageHash",
  "signature",
  "logoBase64",
  "submittedAt",
]);
const DAPP_INFO_KEYS = new Set(["title", "description", "url", "chains", "category"]);
const ATTESTATION_DOC_KEYS = new Set([
  "version",
  "kind",
  "chainPath",
  "targetIdentityAddress",
  "attestation",
  "submittedAt",
]);
const CATEGORY_OTHER_RE = /^[a-zA-Z0-9 .'+\-%/À-ÖØ-öø-ÿ:&()[\]?{};~!_@]{2,32}$/;
const SIGNATURES_ROOT_KEYS = new Set(["identityAddress", "verificationInstructions", "signatures"]);
const SIGNATURE_ENTRY_KEYS = new Set([
  "signerName",
  "signerAddress",
  "messageHash",
  "signature",
  "date",
]);

export function isAllowedIntakeObjectName(name: string): boolean {
  if (name.includes("..") || name.includes("\\") || name.startsWith("/")) return false;
  // Sealed forensics live in a separate bucket; never pull *.sealed from intake.
  if (name.endsWith(".sealed")) return false;
  if (/^eip155-(14|19)\/0x[0-9a-f]{40}\.json$/.test(name)) return true;
  if (/^dapps\/0x[0-9a-f]{40}\/[a-z0-9][a-z0-9-]{0,63}\.json$/.test(name)) return true;
  // Attestations: attestations/<chain>/<target identity>/<attester identity>.json
  if (/^attestations\/eip155-(14|19)\/0x[0-9a-f]{40}\/0x[0-9a-f]{40}\.json$/.test(name)) {
    return true;
  }
  return false;
}

export function parseIntakeJsonObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw, (key, val) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error("Forbidden JSON key");
    }
    return val;
  });
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Intake document must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  object: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(`Unexpected ${label} field: ${key}`);
    }
  }
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function decodeStrictLogoBase64(logoBase64: unknown): Buffer {
  const encoded = assertString(logoBase64, "logoBase64");
  if (encoded.length === 0 || encoded.length > MAX_LOGO_BASE64_CHARS) {
    throw new Error("logoBase64 length out of range");
  }
  if (encoded.includes("\n") || encoded.includes("\r") || encoded.includes(" ")) {
    throw new Error("logoBase64 must be compact base64");
  }
  if (!BASE64_RE.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error("logoBase64 is not valid base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error("logoBase64 must be canonical base64");
  }
  if (bytes.length / 1024 > PROVIDER_LOGO_REQUIREMENTS.MAX_SIZE_KB) {
    throw new Error("Logo exceeds max size");
  }
  return bytes;
}

/** Provider intake: exact 128×128 WebP. */
function decodeStrictWebpBase64(logoBase64: unknown): { bytes: Buffer; logoHash: string } {
  const bytes = decodeStrictLogoBase64(logoBase64);
  if (!isWebpMagic(bytes)) throw new Error("Logo is not a valid WebP");
  const dims = readWebpDimensions(bytes);
  if (!dims) throw new Error("Could not parse WebP dimensions");
  if (
    dims.width !== PROVIDER_LOGO_REQUIREMENTS.WIDTH ||
    dims.height !== PROVIDER_LOGO_REQUIREMENTS.HEIGHT
  ) {
    throw new Error(
      `Logo must be exactly ${PROVIDER_LOGO_REQUIREMENTS.WIDTH}×${PROVIDER_LOGO_REQUIREMENTS.HEIGHT}px, got ${dims.width}x${dims.height}`,
    );
  }
  return { bytes, logoHash: createHash("sha256").update(bytes).digest("hex") };
}

/** Validate + normalize a provider intake document from GCS (clear listing only). */
export function assertProviderIntakeDocument(doc: Record<string, unknown>): {
  chainPath: string;
  info: Record<string, unknown>;
  signatures: Record<string, unknown>;
  logoBase64: string;
  submittedAt: string;
} {
  assertOnlyKeys(doc, PROVIDER_DOC_KEYS, "provider document");
  if (doc.version !== 1) throw new Error(`Unsupported version: ${doc.version}`);
  if (doc.kind !== undefined && doc.kind !== "provider") {
    throw new Error(`Unexpected kind: ${String(doc.kind)}`);
  }
  const chainPath = assertString(doc.chainPath, "chainPath");
  if (chainPath !== "eip155-14" && chainPath !== "eip155-19") {
    throw new Error(`Unsupported chainPath: ${chainPath}`);
  }
  const submittedAt = assertString(doc.submittedAt, "submittedAt");
  if (!ISO_DATE_RE.test(submittedAt)) throw new Error("Invalid submittedAt");

  if (doc.info === null || typeof doc.info !== "object" || Array.isArray(doc.info)) {
    throw new Error("info must be an object");
  }
  const info = doc.info as Record<string, unknown>;
  assertOnlyKeys(info, new Set(PROVIDER_INFO_KEYS), "info");

  const { logoHash } = decodeStrictWebpBase64(doc.logoBase64);
  const claimedHash = assertString(info.logoHash, "logoHash").toLowerCase();
  if (claimedHash !== logoHash) throw new Error("logoHash does not match logo bytes");

  const identity = assertString(info.identityAddress, "identityAddress").toLowerCase();
  if (!isValidEvmAddress(identity)) throw new Error("Invalid identityAddress");
  if (!isValidName(assertString(info.name, "name"))) throw new Error("Invalid name");
  if (!isValidDescription(assertString(info.description, "description"))) {
    throw new Error("Invalid description");
  }
  if (!isValidURL(assertString(info.websiteURL, "websiteURL"), "website")) {
    throw new Error("Invalid websiteURL");
  }
  if (assertString(info.logoURL, "logoURL") !== `providers/${chainPath}/${identity}/logo.webp`) {
    throw new Error("Invalid logoURL");
  }
  if (info.listed !== false) throw new Error("listed must be false in intake documents");
  if (info.managementGroup !== false) {
    throw new Error("managementGroup must be false in intake documents");
  }
  if (info.domainLinked !== undefined && info.domainLinked !== false) {
    throw new Error("domainLinked must be false in intake documents");
  }
  if (info.dualNetwork !== undefined && info.dualNetwork !== false) {
    throw new Error("dualNetwork must be false in intake documents");
  }
  if (info.firstTransaction !== undefined) {
    throw new Error("firstTransaction is curator-managed and not allowed in intake documents");
  }
  for (const addressKey of [
    "delegationAddress",
    "signingPolicyAddress",
    "submitAddress",
    "submitSignaturesAddress",
  ] as const) {
    const address = assertString(info[addressKey], addressKey).toLowerCase();
    if (!isValidEvmAddress(address)) throw new Error(`Invalid ${addressKey}`);
    info[addressKey] = address;
  }
  if (!isValidPublicKey(assertString(info.publicKey, "publicKey"))) {
    throw new Error("Invalid publicKey");
  }
  if (!Array.isArray(info.validators) || info.validators.length > 64) {
    throw new Error("Invalid validators");
  }
  for (const nodeId of info.validators) {
    if (typeof nodeId !== "string" || !isValidNodeID(nodeId)) {
      throw new Error(`Invalid validator: ${String(nodeId)}`);
    }
  }
  if (info.acknowledgedResponsibilities !== true) {
    throw new Error("acknowledgedResponsibilities must be true");
  }
  if (info.links === null || typeof info.links !== "object" || Array.isArray(info.links)) {
    throw new Error("links must be an object");
  }
  const links = info.links as Record<string, unknown>;
  assertOnlyKeys(links, new Set(ALLOWED_LINKS), "links");
  for (const [key, value] of Object.entries(links)) {
    if (typeof value !== "string" || !isValidURL(value, key as (typeof ALLOWED_LINKS)[number])) {
      throw new Error(`Invalid link ${key}`);
    }
  }

  if (
    doc.signatures === null ||
    typeof doc.signatures !== "object" ||
    Array.isArray(doc.signatures)
  ) {
    throw new Error("signatures must be an object");
  }
  const signatures = doc.signatures as Record<string, unknown>;
  assertOnlyKeys(signatures, SIGNATURES_ROOT_KEYS, "signatures");
  if (
    assertString(signatures.identityAddress, "signatures.identityAddress").toLowerCase() !==
    identity
  ) {
    throw new Error("signatures.identityAddress mismatch");
  }
  if (signatures.verificationInstructions !== PROVIDER_VERIFICATION_INSTRUCTIONS) {
    throw new Error("Unexpected verificationInstructions");
  }
  if (!Array.isArray(signatures.signatures) || signatures.signatures.length === 0) {
    throw new Error("signatures.signatures must be non-empty");
  }
  if (signatures.signatures.length > 8) throw new Error("Too many signatures");
  for (const entry of signatures.signatures) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Invalid signature entry");
    }
    const row = entry as Record<string, unknown>;
    assertOnlyKeys(row, SIGNATURE_ENTRY_KEYS, "signature entry");
    if (!isValidName(assertString(row.signerName, "signerName"))) {
      throw new Error("Invalid signerName");
    }
    if (!isValidEvmAddress(assertString(row.signerAddress, "signerAddress"))) {
      throw new Error("Invalid signerAddress");
    }
    if (!MESSAGE_HASH_RE.test(assertString(row.messageHash, "messageHash").toLowerCase())) {
      throw new Error("Invalid messageHash");
    }
    if (!SIG_HEX_RE.test(assertString(row.signature, "signature"))) {
      throw new Error("Invalid signature");
    }
    if (!ISO_DATE_RE.test(assertString(row.date, "date"))) {
      throw new Error("Invalid signature date");
    }
  }

  info.identityAddress = identity;
  info.logoHash = logoHash;
  info.acknowledgedResponsibilities = true;
  info.listed = false;
  info.managementGroup = false;
  info.domainLinked = false;
  info.dualNetwork = false;

  return {
    chainPath,
    info,
    signatures,
    logoBase64: assertString(doc.logoBase64, "logoBase64"),
    submittedAt,
  };
}

/**
 * Validate + normalize an attestation intake document from GCS: one provider
 * signing another provider's current entry through the web app. Self-signatures
 * must go through the listing submission flow instead.
 */
export function assertAttestationIntakeDocument(doc: Record<string, unknown>): {
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
} {
  assertOnlyKeys(doc, ATTESTATION_DOC_KEYS, "attestation document");
  if (doc.version !== 1) throw new Error(`Unsupported version: ${doc.version}`);
  if (doc.kind !== "attestation") throw new Error("kind must be attestation");
  const chainPath = assertString(doc.chainPath, "chainPath");
  if (chainPath !== "eip155-14" && chainPath !== "eip155-19") {
    throw new Error(`Unsupported chainPath: ${chainPath}`);
  }
  const submittedAt = assertString(doc.submittedAt, "submittedAt");
  if (!ISO_DATE_RE.test(submittedAt)) throw new Error("Invalid submittedAt");

  const target = assertString(doc.targetIdentityAddress, "targetIdentityAddress").toLowerCase();
  if (!isValidEvmAddress(target)) throw new Error("Invalid targetIdentityAddress");

  if (
    doc.attestation === null ||
    typeof doc.attestation !== "object" ||
    Array.isArray(doc.attestation)
  ) {
    throw new Error("attestation must be an object");
  }
  const row = doc.attestation as Record<string, unknown>;
  assertOnlyKeys(row, SIGNATURE_ENTRY_KEYS, "attestation entry");
  if (!isValidName(assertString(row.signerName, "signerName"))) {
    throw new Error("Invalid signerName");
  }
  const signer = assertString(row.signerAddress, "signerAddress").toLowerCase();
  if (!isValidEvmAddress(signer)) throw new Error("Invalid signerAddress");
  if (signer === target) {
    throw new Error("Self-signatures must go through the listing submission flow");
  }
  const messageHash = assertString(row.messageHash, "messageHash").toLowerCase();
  if (!MESSAGE_HASH_RE.test(messageHash)) throw new Error("Invalid messageHash");
  const signature = assertString(row.signature, "signature");
  if (!SIG_HEX_RE.test(signature)) throw new Error("Invalid signature");
  const date = assertString(row.date, "date");
  if (!ISO_DATE_RE.test(date)) throw new Error("Invalid signature date");

  return {
    chainPath,
    targetIdentityAddress: target,
    attestation: {
      signerName: assertString(row.signerName, "signerName"),
      signerAddress: signer,
      messageHash,
      signature,
      date,
    },
    submittedAt,
  };
}

/** Validate + normalize a dapp intake document from GCS (clear listing only). */
export function assertDappIntakeDocument(doc: Record<string, unknown>): {
  info: {
    title: string;
    description: string;
    url: string;
    chains: string[];
    category: string;
  };
  /** Curator hint when category is `other`; not written to the catalog. */
  categoryOther?: string;
  submitter: string;
  messageHash: string;
  signature: string;
  logoBase64: string;
  submittedAt: string;
} {
  assertOnlyKeys(doc, DAPP_DOC_KEYS, "dapp document");
  if (doc.version !== 1) throw new Error(`Unsupported version: ${doc.version}`);
  if (doc.kind !== "dapp") throw new Error("kind must be dapp");
  const submittedAt = assertString(doc.submittedAt, "submittedAt");
  if (!ISO_DATE_RE.test(submittedAt)) throw new Error("Invalid submittedAt");

  if (doc.info === null || typeof doc.info !== "object" || Array.isArray(doc.info)) {
    throw new Error("info must be an object");
  }
  const infoIn = doc.info as Record<string, unknown>;
  assertOnlyKeys(infoIn, DAPP_INFO_KEYS, "info");

  const title = assertString(infoIn.title, "title");
  const description = assertString(infoIn.description, "description");
  const url = assertString(infoIn.url, "url");
  if (!isValidName(title)) throw new Error("Invalid title");
  if (!isValidDescription(description)) throw new Error("Invalid description");
  if (!isValidURL(url, "website")) throw new Error("Invalid url");
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("url must not include credentials, query, or fragment");
  }

  if (
    !Array.isArray(infoIn.chains) ||
    infoIn.chains.length === 0 ||
    infoIn.chains.length > DAPP_ALLOWED_CHAINS.size
  ) {
    throw new Error("Invalid chains");
  }
  const chains: string[] = [];
  for (const chain of infoIn.chains) {
    if (typeof chain !== "string" || !DAPP_ALLOWED_CHAINS.has(chain)) {
      throw new Error(`Unsupported chain: ${String(chain)}`);
    }
    chains.push(chain);
  }
  if (new Set(chains).size !== chains.length) throw new Error("Duplicate chains");

  const category = assertString(infoIn.category, "category");
  if (!(DAPP_CATEGORIES as readonly string[]).includes(category)) {
    throw new Error(`Unknown category: ${category}`);
  }

  let categoryOther: string | undefined;
  if (doc.categoryOther !== undefined) {
    if (typeof doc.categoryOther !== "string" || !CATEGORY_OTHER_RE.test(doc.categoryOther)) {
      throw new Error("Invalid categoryOther");
    }
    if (category !== "other") {
      throw new Error("categoryOther is only allowed when category is other");
    }
    categoryOther = doc.categoryOther;
  }

  const submitter = assertString(doc.submitter, "submitter").toLowerCase();
  if (!isValidEvmAddress(submitter)) throw new Error("Invalid submitter");
  const messageHash = assertString(doc.messageHash, "messageHash").toLowerCase();
  if (!MESSAGE_HASH_RE.test(messageHash)) throw new Error("Invalid messageHash");
  const signature = assertString(doc.signature, "signature");
  if (!SIG_HEX_RE.test(signature)) throw new Error("Invalid signature");
  decodeStrictWebpBase64(doc.logoBase64);

  return {
    info: {
      title,
      description,
      url,
      chains: [...chains].sort(),
      category,
    },
    ...(categoryOther ? { categoryOther } : {}),
    submitter,
    messageHash,
    signature,
    logoBase64: assertString(doc.logoBase64, "logoBase64"),
    submittedAt,
  };
}

export { MAX_INTAKE_OBJECT_BYTES };
