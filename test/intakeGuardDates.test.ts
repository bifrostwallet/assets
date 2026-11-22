import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { providerLogoPath, sha256Hex } from "../src/convert.js";
import { PROVIDER_VERIFICATION_INSTRUCTIONS } from "../src/eip712.js";
import {
  assertAttestationIntakeDocument,
  assertProviderIntakeDocument,
  MAX_SIGNATURE_AGE_AT_SUBMISSION_MS,
} from "../src/intakeGuard.js";

const logo = fs.readFileSync(path.join(process.cwd(), "data/dapps/kinetic-market/logo.webp"));
const identity = `0x${"ab".repeat(20)}`;
const attester = `0x${"cd".repeat(20)}`;
const SUBMITTED_AT = "2026-11-22T10:46:12.951Z";
const SUBMITTED_MS = Date.parse(SUBMITTED_AT);
const NOW = SUBMITTED_MS + 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function providerDoc(date: string, submittedAt = SUBMITTED_AT): Record<string, unknown> {
  return {
    version: 1,
    kind: "provider",
    chainPath: "eip155-19",
    info: {
      name: "Test Provider",
      description: "A provider used only in intake guard tests.",
      logoURL: providerLogoPath("eip155-19", identity),
      logoHash: sha256Hex(logo),
      websiteURL: "https://example.com",
      links: {},
      identityAddress: identity,
      delegationAddress: identity,
      signingPolicyAddress: identity,
      submitAddress: identity,
      submitSignaturesAddress: identity,
      publicKey: `0x${"11".repeat(64)}`,
      validators: [],
      acknowledgedResponsibilities: true,
      listed: false,
      managementGroup: false,
      domainLinked: false,
      dualNetwork: false,
    },
    signatures: {
      identityAddress: identity,
      verificationInstructions: PROVIDER_VERIFICATION_INSTRUCTIONS,
      signatures: [
        {
          signerName: "Test Provider",
          signerAddress: identity,
          messageHash: `0x${"12".repeat(32)}`,
          signature: `0x${"34".repeat(65)}`,
          date,
          version: 2,
          nonce: `bwn1.1763811972951.${"A".repeat(22)}.${"B".repeat(43)}`,
          sealedHash: `0x${"56".repeat(32)}`,
        },
      ],
    },
    logoBase64: logo.toString("base64"),
    submittedAt,
  };
}

function attestationDoc(date: string, submittedAt = SUBMITTED_AT): Record<string, unknown> {
  return {
    version: 1,
    kind: "attestation",
    chainPath: "eip155-14",
    targetIdentityAddress: identity,
    attestation: {
      signerName: "Attester Provider",
      signerAddress: attester,
      messageHash: `0x${"12".repeat(32)}`,
      signature: `0x${"34".repeat(65)}`,
      date,
    },
    submittedAt,
  };
}

function storedProviderDate(doc: Record<string, unknown>): string {
  const { signatures } = assertProviderIntakeDocument(doc, NOW);
  const rows = signatures.signatures as Array<{ date: string }>;
  assert.equal(rows.length, 1);
  return String(rows[0]?.date);
}

function listingEntry(doc: Record<string, unknown>): Record<string, unknown> {
  const root = doc.signatures as { signatures: Record<string, unknown>[] };
  return root.signatures[0] as Record<string, unknown>;
}

describe("intake guard listing signature shape", () => {
  test("accepts one version 2 self-signature", () => {
    assert.equal(storedProviderDate(providerDoc(SUBMITTED_AT)), SUBMITTED_AT);
  });

  test("refuses a version 1 entry (no version, nonce or sealedHash)", () => {
    const doc = providerDoc(SUBMITTED_AT);
    const entry = listingEntry(doc);
    delete entry.version;
    delete entry.nonce;
    delete entry.sealedHash;
    assert.throws(() => assertProviderIntakeDocument(doc, NOW), /signature version 2/);
  });

  test("refuses a missing nonce or a malformed sealedHash", () => {
    const noNonce = providerDoc(SUBMITTED_AT);
    delete listingEntry(noNonce).nonce;
    assert.throws(() => assertProviderIntakeDocument(noNonce, NOW), /nonce/);
    const badHash = providerDoc(SUBMITTED_AT);
    listingEntry(badHash).sealedHash = "0x12";
    assert.throws(() => assertProviderIntakeDocument(badHash, NOW), /Invalid sealedHash/);
  });

  test("refuses a second entry and a signature from another address", () => {
    const two = providerDoc(SUBMITTED_AT);
    const root = two.signatures as { signatures: Record<string, unknown>[] };
    root.signatures.push({ ...listingEntry(two), signerAddress: attester });
    assert.throws(() => assertProviderIntakeDocument(two, NOW), /exactly one self-signature/);
    const stranger = providerDoc(SUBMITTED_AT);
    listingEntry(stranger).signerAddress = attester;
    assert.throws(() => assertProviderIntakeDocument(stranger, NOW), /from the identity address/);
  });
});

describe("intake guard signature dates", () => {
  test("refuses a signature dated years after submission", () => {
    assert.throws(
      () => assertProviderIntakeDocument(providerDoc("2031-05-01T00:00:00.000Z"), NOW),
      /after submittedAt/,
    );
  });

  test("refuses a signature dated even 1 ms after submittedAt", () => {
    const late = iso(SUBMITTED_MS + 1);
    assert.throws(() => assertProviderIntakeDocument(providerDoc(late), NOW), /after submittedAt/);
    assert.throws(
      () => assertAttestationIntakeDocument(attestationDoc(late), NOW),
      /after submittedAt/,
    );
  });

  test("keeps a date at or before submittedAt as submitted", () => {
    const before = iso(SUBMITTED_MS - 8_716);
    assert.equal(storedProviderDate(providerDoc(before)), before);
    assert.equal(storedProviderDate(providerDoc(SUBMITTED_AT)), SUBMITTED_AT);
  });

  test("refuses a listing signature made long before submission", () => {
    assert.throws(
      () =>
        assertProviderIntakeDocument(
          providerDoc("2026-10-18T00:26:06.465Z", "2026-11-05T18:46:07.811Z"),
          Date.parse("2026-11-05T19:00:00.000Z"),
        ),
      /too long before submittedAt/,
    );
    const tooOld = iso(SUBMITTED_MS - MAX_SIGNATURE_AGE_AT_SUBMISSION_MS - 1);
    assert.throws(
      () => assertProviderIntakeDocument(providerDoc(tooOld), NOW),
      /too long before submittedAt/,
    );
    const oldButOk = iso(SUBMITTED_MS - MAX_SIGNATURE_AGE_AT_SUBMISSION_MS);
    assert.equal(storedProviderDate(providerDoc(oldButOk)), oldButOk);
  });

  test("refuses a submittedAt in the future", () => {
    const future = iso(NOW + 1);
    assert.throws(
      () => assertProviderIntakeDocument(providerDoc(future, future), NOW),
      /submittedAt is in the future/,
    );
    assert.throws(
      () => assertAttestationIntakeDocument(attestationDoc(future, future), NOW),
      /submittedAt is in the future/,
    );
  });
});
