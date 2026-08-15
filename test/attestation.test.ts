import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ProviderInfo } from "../src/config.js";
import { providerListingTypedData } from "../src/eip712.js";
import { type IntakeAttestation, ingestProviderAttestation } from "../src/ingest.js";
import {
  assertAttestationIntakeDocument,
  isAllowedIntakeObjectName,
  PROVIDER_VERIFICATION_INSTRUCTIONS,
} from "../src/intakeGuard.js";
import type { SignaturesData } from "../src/verify.js";

const targetAccount = privateKeyToAccount(generatePrivateKey());
const attesterAccount = privateKeyToAccount(generatePrivateKey());
const targetIdentity = targetAccount.address.toLowerCase();
const attesterIdentity = attesterAccount.address.toLowerCase();

function providerInfo(identity: string, name: string, listed: boolean): Partial<ProviderInfo> {
  return {
    name,
    description: "A provider used in attestation tests",
    logoURL: `providers/eip155-14/${identity}/logo.webp`,
    logoHash: "0".repeat(64),
    websiteURL: "https://example.com",
    links: {},
    identityAddress: identity,
    delegationAddress: identity,
    signingPolicyAddress: identity,
    submitAddress: identity,
    submitSignaturesAddress: identity,
    publicKey: `0x${"1".repeat(128)}`,
    validators: [],
    listed,
    managementGroup: false,
    domainLinked: false,
    dualNetwork: false,
  };
}

async function signListing(info: Partial<ProviderInfo>, account: typeof attesterAccount) {
  const typed = providerListingTypedData(info, 14);
  return {
    messageHash: typed.contentHash,
    signature: await account.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    }),
  };
}

async function validAttestationDoc(): Promise<Record<string, unknown>> {
  const info = providerInfo(targetIdentity, "Target Provider", false);
  const signed = await signListing(info, attesterAccount);
  return {
    version: 1,
    kind: "attestation",
    chainPath: "eip155-14",
    targetIdentityAddress: targetIdentity,
    attestation: {
      signerName: "Attester Provider",
      signerAddress: attesterIdentity,
      messageHash: signed.messageHash,
      signature: signed.signature,
      date: "2026-07-24T12:00:00.000Z",
    },
    submittedAt: "2026-07-24T12:00:00.000Z",
  };
}

describe("Attestation intake guard", () => {
  test("allows attestation object names and rejects malformed ones", () => {
    assert.equal(
      isAllowedIntakeObjectName(
        `attestations/eip155-14/${targetIdentity}/${attesterIdentity}.json`,
      ),
      true,
    );
    assert.equal(
      isAllowedIntakeObjectName(`attestations/eip155-1/${targetIdentity}/${attesterIdentity}.json`),
      false,
    );
    assert.equal(isAllowedIntakeObjectName(`attestations/eip155-14/${targetIdentity}.json`), false);
  });

  test("accepts a valid attestation document", async () => {
    const sanitized = assertAttestationIntakeDocument(await validAttestationDoc());
    assert.equal(sanitized.chainPath, "eip155-14");
    assert.equal(sanitized.targetIdentityAddress, targetIdentity);
    assert.equal(sanitized.attestation.signerAddress, attesterIdentity);
  });

  test("rejects self-attestation", async () => {
    const doc = await validAttestationDoc();
    (doc.attestation as Record<string, unknown>).signerAddress = targetIdentity;
    assert.throws(
      () => assertAttestationIntakeDocument(doc),
      /Self-signatures must go through the listing submission flow/,
    );
  });

  test("rejects unexpected fields and wrong kind", async () => {
    const withExtra = { ...(await validAttestationDoc()), extra: true };
    assert.throws(() => assertAttestationIntakeDocument(withExtra), /Unexpected/);

    const wrongKind = { ...(await validAttestationDoc()), kind: "provider" };
    assert.throws(() => assertAttestationIntakeDocument(wrongKind), /kind must be attestation/);
  });
});

describe("Attestation ingest", () => {
  const originalCwd = process.cwd();
  let root: string;

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "assets-attestation-ingest-"));
    const chainDir = path.join(root, "data", "providers", "eip155-14");

    // Target entry (unsigned)
    const targetDir = path.join(chainDir, targetIdentity);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, "info.json"),
      JSON.stringify(providerInfo(targetIdentity, "Target Provider", false), null, 2),
    );

    // Attester entry: listed + self-signed
    const attesterInfo = providerInfo(attesterIdentity, "Attester Provider", true);
    const attesterDir = path.join(chainDir, attesterIdentity);
    fs.mkdirSync(attesterDir, { recursive: true });
    fs.writeFileSync(path.join(attesterDir, "info.json"), JSON.stringify(attesterInfo, null, 2));
    const attesterSigned = await signListing(attesterInfo, attesterAccount);
    fs.writeFileSync(
      path.join(attesterDir, "signatures.json"),
      JSON.stringify({
        identityAddress: attesterIdentity,
        verificationInstructions: PROVIDER_VERIFICATION_INSTRUCTIONS,
        signatures: [
          {
            signerName: attesterInfo.name,
            signerAddress: attesterAccount.address,
            messageHash: attesterSigned.messageHash,
            signature: attesterSigned.signature,
            date: "2026-07-24T12:00:00.000Z",
          },
        ],
      }),
    );

    process.chdir(root);
  });

  after(() => {
    process.chdir(originalCwd);
  });

  test("merges a valid attestation and is idempotent", async () => {
    const doc = assertAttestationIntakeDocument(await validAttestationDoc()) as IntakeAttestation;

    const first = await ingestProviderAttestation(doc);
    assert.equal(first.status, "ingested");

    const signaturesPath = path.join(
      root,
      "data",
      "providers",
      "eip155-14",
      targetIdentity,
      "signatures.json",
    );
    const written = JSON.parse(fs.readFileSync(signaturesPath, "utf8")) as SignaturesData;
    assert.equal(written.identityAddress, targetIdentity);
    assert.equal(written.verificationInstructions, PROVIDER_VERIFICATION_INSTRUCTIONS);
    assert.equal(written.signatures.length, 1);
    assert.equal(written.signatures[0].signerAddress.toLowerCase(), attesterIdentity);

    const second = await ingestProviderAttestation(doc);
    assert.equal(second.status, "unchanged");
  });

  test("rejects a stale attestation after the target entry changes", async () => {
    const doc = assertAttestationIntakeDocument(await validAttestationDoc()) as IntakeAttestation;
    const infoPath = path.join(root, "data", "providers", "eip155-14", targetIdentity, "info.json");
    const original = fs.readFileSync(infoPath, "utf8");
    const mutated = { ...JSON.parse(original), name: "Renamed Provider" };
    fs.writeFileSync(infoPath, JSON.stringify(mutated, null, 2));

    await assert.rejects(() => ingestProviderAttestation(doc), /Stale attestation/);
    fs.writeFileSync(infoPath, original);
  });

  test("rejects attestations from unqualified attesters", async () => {
    const doc = assertAttestationIntakeDocument(await validAttestationDoc()) as IntakeAttestation;
    const attesterInfoPath = path.join(
      root,
      "data",
      "providers",
      "eip155-14",
      attesterIdentity,
      "info.json",
    );
    const original = fs.readFileSync(attesterInfoPath, "utf8");
    fs.writeFileSync(
      attesterInfoPath,
      JSON.stringify({ ...JSON.parse(original), listed: false }, null, 2),
    );

    await assert.rejects(() => ingestProviderAttestation(doc), /does not qualify/);
    fs.writeFileSync(attesterInfoPath, original);
  });

  test("rejects attestations for unknown providers", async () => {
    const doc = assertAttestationIntakeDocument(await validAttestationDoc()) as IntakeAttestation;
    const unknown = {
      ...doc,
      targetIdentityAddress: `0x${"9".repeat(40)}`,
    };
    await assert.rejects(() => ingestProviderAttestation(unknown), /does not exist/);
  });
});
