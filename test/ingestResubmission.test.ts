import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ProviderInfo } from "../src/config.js";
import { providerLogoPath, sha256Hex } from "../src/convert.js";
import {
  PROVIDER_VERIFICATION_INSTRUCTIONS,
  providerListingTypedDataFromInfo,
  providerListingV2TypedDataFromInfo,
} from "../src/eip712.js";
import {
  type IntakeSubmission,
  ingestProviderSubmission,
  intakeSubmissionToDir,
} from "../src/ingest.js";
import type { SignatureEntry, SignaturesData } from "../src/verify.js";

const ORIGINAL_SUBMITTED_AT = "2026-10-18T00:26:11.817Z";
const RESUBMITTED_AT = "2026-11-03T00:00:00.000Z";

const logo = fs.readFileSync(path.join(process.cwd(), "data/dapps/kinetic-market/logo.webp"));
const logoHash = sha256Hex(logo);

function snapshotFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (current: string, prefix: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        out.set(rel, fs.readFileSync(full));
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out;
}

function assertSnapshotUnchanged(dir: string, beforeSnapshot: Map<string, Buffer>): void {
  const afterSnapshot = snapshotFiles(dir);
  assert.deepEqual([...afterSnapshot.keys()].sort(), [...beforeSnapshot.keys()].sort());
  for (const [rel, bytes] of beforeSnapshot) {
    assert.deepEqual(afterSnapshot.get(rel), bytes, rel);
  }
}

function entityFields(
  identity: string,
  managementGroup: boolean | "missing" = false,
): Partial<ProviderInfo> {
  const fields: Partial<ProviderInfo> = {
    delegationAddress: identity,
    signingPolicyAddress: identity,
    submitAddress: identity,
    submitSignaturesAddress: identity,
    publicKey: `0x${"11".repeat(64)}`,
    validators: [],
  };
  if (managementGroup !== "missing") {
    fields.managementGroup = managementGroup;
  }
  return fields;
}

async function providerSignature(
  info: Partial<ProviderInfo>,
  account: ReturnType<typeof privateKeyToAccount>,
  date = ORIGINAL_SUBMITTED_AT,
): Promise<SignatureEntry> {
  const typed = providerListingTypedDataFromInfo(info, 14);
  const signature = await account.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  return {
    signerName: String(info.name),
    signerAddress: account.address,
    messageHash: typed.contentHash,
    signature,
    date,
  };
}

async function providerSignatureV2(
  info: Partial<ProviderInfo>,
  account: ReturnType<typeof privateKeyToAccount>,
  date: string,
): Promise<SignatureEntry> {
  const fields = {
    signedAt: date,
    nonce: `bwn1.${Date.parse(date) + 3_600_000}.${"A".repeat(22)}.${"B".repeat(43)}`,
    sealedHash: `0x${"cd".repeat(32)}`,
  };
  const typed = providerListingV2TypedDataFromInfo(info, 14, fields);
  const signature = await account.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  });
  return {
    signerName: String(info.name),
    signerAddress: account.address,
    messageHash: typed.contentHash,
    signature,
    date,
    version: 2,
    nonce: fields.nonce,
    sealedHash: fields.sealedHash,
  };
}

function providerInfo(identity: string, description: string): ProviderInfo {
  return {
    name: "Test Provider",
    description,
    logoURL: providerLogoPath("eip155-14", identity),
    logoHash,
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
  };
}

async function ingestProvider(
  identity: string,
  description: string,
  signatures: SignatureEntry[],
  submittedAt: string,
  managementGroup: boolean | "missing" = false,
) {
  const info = providerInfo(identity, description);
  const submission: IntakeSubmission = {
    version: 1,
    chainPath: "eip155-14",
    info,
    signatures: {
      identityAddress: identity,
      verificationInstructions: PROVIDER_VERIFICATION_INSTRUCTIONS,
      signatures,
    } satisfies SignaturesData,
    logoBase64: logo.toString("base64"),
    submittedAt,
  };
  const sourceDir = intakeSubmissionToDir(submission);
  return ingestProviderSubmission(sourceDir, {
    chainPath: "eip155-14",
    readEntityData: async () => entityFields(identity, managementGroup),
  });
}

describe("Intake resubmission provenance", { concurrency: false }, () => {
  const originalCwd = process.cwd();
  let root: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "assets-ingest-resubmit-"));
    process.chdir(root);
  });

  after(() => {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("keeps provider provenance when info.json and the logo are unchanged", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const description = "A provider used to test intake resubmission.";
    const selfSignature = await providerSignature(providerInfo(identity, description), account);

    const first = await ingestProvider(
      identity,
      description,
      [selfSignature],
      ORIGINAL_SUBMITTED_AT,
    );
    assert.equal(first.status, "ingested");

    const providerDir = path.join(root, "data", "providers", "eip155-14", identity);
    const chainDir = path.join(root, "data", "providers", "eip155-14");
    const beforeSnapshot = snapshotFiles(chainDir);
    const provenance = JSON.parse(
      fs.readFileSync(path.join(providerDir, "provenance.json"), "utf8"),
    ) as { submittedAt: string };
    assert.equal(provenance.submittedAt, ORIGINAL_SUBMITTED_AT);

    const second = await ingestProvider(identity, description, [selfSignature], RESUBMITTED_AT);
    assert.equal(second.status, "unchanged");
    assertSnapshotUnchanged(chainDir, beforeSnapshot);
  });

  test("keeps provider provenance when only signatures change", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const attester = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const description = "A provider used to test signature-only resubmission.";
    const info = providerInfo(identity, description);
    const selfSignature = await providerSignature(info, account);

    const first = await ingestProvider(
      identity,
      description,
      [selfSignature],
      ORIGINAL_SUBMITTED_AT,
    );
    assert.equal(first.status, "ingested");

    const providerDir = path.join(root, "data", "providers", "eip155-14", identity);
    const provenancePath = path.join(providerDir, "provenance.json");
    const provenanceBefore = fs.readFileSync(provenancePath);

    const extra = await providerSignature(info, attester);
    const second = await ingestProvider(
      identity,
      description,
      [selfSignature, extra],
      RESUBMITTED_AT,
    );
    assert.equal(second.status, "ingested");
    assert.deepEqual(fs.readFileSync(provenancePath), provenanceBefore);

    const signatures = JSON.parse(
      fs.readFileSync(path.join(providerDir, "signatures.json"), "utf8"),
    ) as SignaturesData;
    assert.equal(signatures.signatures.length, 2);
  });

  test("updates provider provenance when info.json changes", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const original = "A provider used to test a real catalog change.";
    const updated = "A provider whose description changed on resubmission.";
    const firstSignature = await providerSignature(providerInfo(identity, original), account);
    const first = await ingestProvider(identity, original, [firstSignature], ORIGINAL_SUBMITTED_AT);
    assert.equal(first.status, "ingested");

    const secondSignature = await providerSignature(
      providerInfo(identity, updated),
      account,
      RESUBMITTED_AT,
    );
    const second = await ingestProvider(identity, updated, [secondSignature], RESUBMITTED_AT);
    assert.equal(second.status, "ingested");

    const provenance = JSON.parse(
      fs.readFileSync(
        path.join(root, "data", "providers", "eip155-14", identity, "provenance.json"),
        "utf8",
      ),
    ) as { submittedAt: string };
    assert.equal(provenance.submittedAt, RESUBMITTED_AT);
  });

  test("refuses a submission that carries an invalid signature entry and writes nothing", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const description = "A provider whose submission carries a replayed signature.";
    const info = providerInfo(identity, description);
    const selfSignature = await providerSignature(info, account);

    // Signed by another key over older content: stale hash, then wrong signer.
    const staleHash: SignatureEntry = {
      ...selfSignature,
      messageHash: `0x${"ab".repeat(32)}`,
    };
    const wrongSigner: SignatureEntry = {
      ...selfSignature,
      signerAddress: stranger.address,
    };

    for (const bad of [staleHash, wrongSigner]) {
      await assert.rejects(
        ingestProvider(identity, description, [selfSignature, bad], ORIGINAL_SUBMITTED_AT),
        /Refusing submission with invalid signature entries/,
      );
      assert.equal(
        fs.existsSync(path.join(root, "data", "providers", "eip155-14", identity)),
        false,
      );
    }

    // The same provider still ingests cleanly once the bad entry is gone.
    const ok = await ingestProvider(identity, description, [selfSignature], ORIGINAL_SUBMITTED_AT);
    assert.equal(ok.status, "ingested");
  });

  test("sets managementGroup from the chain read", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const description = "A provider whose management group flag comes from chain.";
    const submitted = providerInfo(identity, description);
    assert.equal(submitted.managementGroup, false);
    const selfSignature = await providerSignature(submitted, account);

    const result = await ingestProvider(
      identity,
      description,
      [selfSignature],
      ORIGINAL_SUBMITTED_AT,
      true,
    );
    assert.equal(result.status, "ingested");

    const info = JSON.parse(fs.readFileSync(result.infoPath, "utf8")) as ProviderInfo;
    assert.equal(info.managementGroup, true);
    assert.equal(info.listed, false);
  });

  test("throws when the chain read omits managementGroup", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const description = "A provider whose chain read forgot management group.";
    const selfSignature = await providerSignature(providerInfo(identity, description), account);

    await assert.rejects(
      () =>
        ingestProvider(identity, description, [selfSignature], ORIGINAL_SUBMITTED_AT, "missing"),
      /managementGroup was not read from chain/,
    );
    assert.equal(
      fs.existsSync(path.join(root, "data", "providers", "eip155-14", identity, "info.json")),
      false,
    );
  });

  test("ingests a version 2 self-signature and writes its signed fields", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const description = "A provider signing with signature version 2.";
    const entry = await providerSignatureV2(
      providerInfo(identity, description),
      account,
      ORIGINAL_SUBMITTED_AT,
    );
    const result = await ingestProvider(identity, description, [entry], ORIGINAL_SUBMITTED_AT);
    assert.equal(result.status, "ingested");
    const written = JSON.parse(
      fs.readFileSync(
        path.join(root, "data", "providers", "eip155-14", identity, "signatures.json"),
        "utf8",
      ),
    ) as SignaturesData;
    assert.deepEqual(written.signatures, [entry]);
  });

  test("refuses an edited date on a version 2 signature", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const description = "A provider whose signed date was edited.";
    const entry = await providerSignatureV2(
      providerInfo(identity, description),
      account,
      ORIGINAL_SUBMITTED_AT,
    );
    await assert.rejects(
      ingestProvider(
        identity,
        description,
        [{ ...entry, date: "2031-05-01T00:00:00.000Z" }],
        ORIGINAL_SUBMITTED_AT,
      ),
      /No valid self-signature by the identity address/,
    );
  });

  test("refuses a rollback to an older signed version", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const identity = account.address.toLowerCase();
    const older = "The older listing that was replaced later.";
    const newer = "The current listing that replaced the older one.";
    const olderSignature = await providerSignatureV2(
      providerInfo(identity, older),
      account,
      ORIGINAL_SUBMITTED_AT,
    );
    const newerSignature = await providerSignatureV2(
      providerInfo(identity, newer),
      account,
      RESUBMITTED_AT,
    );
    assert.equal(
      (await ingestProvider(identity, older, [olderSignature], ORIGINAL_SUBMITTED_AT)).status,
      "ingested",
    );
    assert.equal(
      (await ingestProvider(identity, newer, [newerSignature], RESUBMITTED_AT)).status,
      "ingested",
    );

    const chainDir = path.join(root, "data", "providers", "eip155-14");
    const beforeSnapshot = snapshotFiles(chainDir);
    await assert.rejects(
      ingestProvider(identity, older, [olderSignature], "2026-11-22T10:46:12.951Z"),
      /not newer than the published one .*refusing a rollback/,
    );
    assertSnapshotUnchanged(chainDir, beforeSnapshot);
  });
});
