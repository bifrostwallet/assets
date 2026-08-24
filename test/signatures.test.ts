import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ProviderInfo } from "../src/config.js";
import { providerListingTypedData } from "../src/eip712.js";
import { findProviderDirs, verifyProviderSignatures } from "../src/verify.js";

/**
 * Cryptographic verification of provider ownership signatures.
 *
 * Every provider must have at least one valid EIP-712 signature in signatures.json
 * over ProviderListing typed data (canonical contentHash + human-readable fields).
 *
 * Enforcement is strict when REQUIRE_PROVIDER_SIGNATURES=1 (set in CI once the
 * one-time Bifrost batch-sign migration has run). Otherwise missing/stale
 * signatures are reported as warnings so the repo stays green during migration.
 */
const strict = process.env.REQUIRE_PROVIDER_SIGNATURES === "1";

describe("Signature round-trip", () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const baseInfo: Partial<ProviderInfo> = {
    name: "Test Provider",
    description: "A test provider used for signature round-trip testing",
    logoURL: "providers/eip155-14/0xabc/logo.webp",
    logoHash: "0".repeat(64),
    websiteURL: "https://example.com",
    links: {},
    identityAddress: account.address.toLowerCase(),
    delegationAddress: account.address.toLowerCase(),
    signingPolicyAddress: account.address.toLowerCase(),
    submitAddress: account.address.toLowerCase(),
    submitSignaturesAddress: account.address.toLowerCase(),
    publicKey: `0x${"1".repeat(128)}`,
    validators: [],
    listed: false,
    managementGroup: false,
    domainLinked: false,
    dualNetwork: false,
  };

  async function writeSignedProvider(info: Partial<ProviderInfo>): Promise<string> {
    const chainDir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "assets-sig-test-")),
      "eip155-14",
    );
    const dir = path.join(chainDir, String(info.identityAddress));
    fs.mkdirSync(dir, { recursive: true });

    const typed = providerListingTypedData(info, 14);
    const signature = await account.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });

    fs.writeFileSync(path.join(dir, "info.json"), JSON.stringify(info, null, 2));
    fs.writeFileSync(
      path.join(dir, "signatures.json"),
      JSON.stringify({
        identityAddress: info.identityAddress,
        verificationInstructions: "",
        signatures: [
          {
            signerName: info.name,
            signerAddress: account.address,
            messageHash: typed.contentHash,
            signature,
            date: new Date().toISOString(),
          },
        ],
      }),
    );
    return dir;
  }

  test("a signed provider verifies with a valid self-signature", async () => {
    const dir = await writeSignedProvider(baseInfo);
    const result = await verifyProviderSignatures(dir);
    assert.equal(result.hasValidSignature, true);
    assert.equal(result.hasValidSelfSignature, true);
  });

  test("changing unsigned fields (listed, managementGroup, domainLinked, dualNetwork, firstTransaction, logoURL) keeps the signature valid", async () => {
    const dir = await writeSignedProvider(baseInfo);
    const infoPath = path.join(dir, "info.json");
    const mutated = {
      ...baseInfo,
      listed: true,
      managementGroup: true,
      domainLinked: true,
      dualNetwork: true,
      firstTransaction: {
        hash: `0x${"a".repeat(64)}`,
        blockNumber: 12345,
        timestamp: "2021-08-10T12:00:00.000Z",
      },
      logoURL: "elsewhere.png",
    };
    fs.writeFileSync(infoPath, JSON.stringify(mutated, null, 2));

    const result = await verifyProviderSignatures(dir);
    assert.equal(result.hasValidSignature, true);
  });

  test("changing a signed field (name) invalidates the signature", async () => {
    const dir = await writeSignedProvider(baseInfo);
    const infoPath = path.join(dir, "info.json");
    fs.writeFileSync(infoPath, JSON.stringify({ ...baseInfo, name: "Imposter" }, null, 2));

    const result = await verifyProviderSignatures(dir);
    assert.equal(result.hasValidSignature, false);
    assert.ok(result.invalidSignatures[0].reason.includes("Stale message hash"));
  });

  test("an attestation qualifies only when the attester is listed and self-signed", async () => {
    const attesterKey = generatePrivateKey();
    const attesterAccount = privateKeyToAccount(attesterKey);
    const attesterIdentity = attesterAccount.address.toLowerCase();

    // Chain directory with two sibling entries: the attester and the target
    const chainDir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "assets-attest-test-")),
      "eip155-14",
    );

    const attesterInfo: Partial<ProviderInfo> = {
      ...baseInfo,
      name: "Attester Provider",
      identityAddress: attesterIdentity,
      listed: true,
    };
    const attesterDir = path.join(chainDir, attesterIdentity);
    fs.mkdirSync(attesterDir, { recursive: true });
    const attesterTyped = providerListingTypedData(attesterInfo, 14);
    fs.writeFileSync(path.join(attesterDir, "info.json"), JSON.stringify(attesterInfo, null, 2));
    fs.writeFileSync(
      path.join(attesterDir, "signatures.json"),
      JSON.stringify({
        identityAddress: attesterIdentity,
        verificationInstructions: "",
        signatures: [
          {
            signerName: attesterInfo.name,
            signerAddress: attesterAccount.address,
            messageHash: attesterTyped.contentHash,
            signature: await attesterAccount.signTypedData({
              domain: attesterTyped.domain,
              types: attesterTyped.types,
              primaryType: attesterTyped.primaryType,
              message: attesterTyped.message,
            }),
            date: new Date().toISOString(),
          },
        ],
      }),
    );

    // Target entry signed only by the attester, not by the identity itself
    const targetDir = path.join(chainDir, baseInfo.identityAddress as string);
    fs.mkdirSync(targetDir, { recursive: true });
    const targetTyped = providerListingTypedData(baseInfo, 14);
    fs.writeFileSync(path.join(targetDir, "info.json"), JSON.stringify(baseInfo, null, 2));
    fs.writeFileSync(
      path.join(targetDir, "signatures.json"),
      JSON.stringify({
        identityAddress: baseInfo.identityAddress,
        verificationInstructions: "",
        signatures: [
          {
            signerName: attesterInfo.name,
            signerAddress: attesterAccount.address,
            messageHash: targetTyped.contentHash,
            signature: await attesterAccount.signTypedData({
              domain: targetTyped.domain,
              types: targetTyped.types,
              primaryType: targetTyped.primaryType,
              message: targetTyped.message,
            }),
            date: new Date().toISOString(),
          },
        ],
      }),
    );

    // Listed + self-signed attester: attestation qualifies
    const qualified = await verifyProviderSignatures(targetDir);
    assert.equal(qualified.hasValidSignature, true);
    assert.equal(qualified.hasValidSelfSignature, false);
    assert.equal(qualified.hasValidAttestation, true);

    // Unlisted attester: no longer qualifies
    fs.writeFileSync(
      path.join(attesterDir, "info.json"),
      JSON.stringify({ ...attesterInfo, listed: false }, null, 2),
    );
    const unlisted = await verifyProviderSignatures(targetDir);
    assert.equal(unlisted.hasValidSignature, true);
    assert.equal(unlisted.hasValidAttestation, false);

    // Listed again but without a self-signature: still no
    fs.writeFileSync(path.join(attesterDir, "info.json"), JSON.stringify(attesterInfo, null, 2));
    fs.rmSync(path.join(attesterDir, "signatures.json"));
    const unsigned = await verifyProviderSignatures(targetDir);
    assert.equal(unsigned.hasValidAttestation, false);

    // Attester with no entry at all: no
    fs.rmSync(attesterDir, { recursive: true });
    const unknown = await verifyProviderSignatures(targetDir);
    assert.equal(unknown.hasValidSignature, true);
    assert.equal(unknown.hasValidAttestation, false);
  });

  test("a signature from a different key is rejected", async () => {
    const dir = await writeSignedProvider(baseInfo);
    const signaturesPath = path.join(dir, "signatures.json");
    const data = JSON.parse(fs.readFileSync(signaturesPath, "utf8"));

    // Forge: sign with a different key over the same typed data
    const otherAccount = privateKeyToAccount(generatePrivateKey());
    const typed = providerListingTypedData(baseInfo, 14);
    data.signatures[0].signature = await otherAccount.signTypedData({
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    fs.writeFileSync(signaturesPath, JSON.stringify(data));

    const result = await verifyProviderSignatures(dir);
    assert.equal(result.hasValidSignature, false);
    assert.ok(result.invalidSignatures[0].reason.includes("does not match declared"));
  });
});

describe("Provider signature verification", () => {
  const providerDirs = findProviderDirs();

  test("Provider directories should exist", () => {
    assert.ok(providerDirs.length > 0);
  });

  for (const providerDir of providerDirs) {
    const relativePath = path.relative(process.cwd(), providerDir);

    test(`${relativePath} should have a valid ownership signature${strict ? "" : " (advisory)"}`, async () => {
      const result = await verifyProviderSignatures(providerDir);

      for (const invalid of result.invalidSignatures) {
        console.warn(
          `⚠️ ${relativePath}: invalid signature from ${invalid.entry.signerAddress}: ${invalid.reason}`,
        );
      }

      if (!result.hasValidSelfSignature) {
        let message = "signatures.json is missing";
        if (result.hasValidAttestation) {
          message = "attested but missing the required self-signature";
        } else if (result.hasSignaturesFile) {
          message =
            "signatures.json exists but contains no valid signature for the current info.json";
        }

        if (strict) {
          throw new Error(`${relativePath}: ${message}`);
        }
        console.warn(`⚠️ ${relativePath}: ${message}`);
      }
    });
  }
});
