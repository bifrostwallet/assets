import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, test } from "node:test";
import { keccak256, recoverTypedDataAddress, toBytes, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ProviderInfo } from "../src/config.js";
import {
  EIP712_DOMAIN_SALT,
  PROVIDER_LISTING_PRIMARY_TYPE,
  PROVIDER_LISTING_TYPES,
  providerListingTypedData,
  providerListingTypedDataFromInfo,
} from "../src/eip712.js";
import buildPackage, { holdPackageDist } from "../src/script/packageBuild.js";

const PORTAL = "https://bifrostwallet.com";

const message = {
  name: "Bifrost Wallet",
  description: "A wallet",
  websiteURL: PORTAL,
  logoHash: `0x${"ab".repeat(32)}` as `0x${string}`,
  identityAddress: "0x1650d2760baee638c034200dedcbe17b050d0364" as `0x${string}`,
  linksJson: JSON.stringify({ github: "https://github.com/bifrostwallet" }),
  acknowledgedResponsibilities: true,
  contentHash: `0x${"cd".repeat(32)}` as `0x${string}`,
};

/** The typed-data object verifiers used to assemble by hand. */
function handBuilt(chainId: number) {
  return {
    domain: {
      name: "Bifrost Assets",
      version: "1",
      chainId,
      salt: keccak256(toBytes(PORTAL)),
    },
    types: {
      ProviderListing: [
        { name: "name", type: "string" },
        { name: "description", type: "string" },
        { name: "websiteURL", type: "string" },
        { name: "logoHash", type: "bytes32" },
        { name: "identityAddress", type: "address" },
        { name: "linksJson", type: "string" },
        { name: "acknowledgedResponsibilities", type: "bool" },
        { name: "contentHash", type: "bytes32" },
      ],
    },
    primaryType: "ProviderListing" as const,
    message,
  };
}

describe("ProviderListing typed data", () => {
  test("precomputed salt is keccak256 of the portal origin", () => {
    assert.equal(EIP712_DOMAIN_SALT, keccak256(toBytes(PORTAL)));
    assert.match(EIP712_DOMAIN_SALT, /^0x[0-9a-f]{64}$/);
  });

  test("helper matches the hand-built typed data", () => {
    assert.deepEqual(providerListingTypedData({ message, chain: "eip155:14" }), handBuilt(14));
    assert.deepEqual(providerListingTypedData({ message, chain: "eip155:19" }), handBuilt(19));
    assert.equal(PROVIDER_LISTING_PRIMARY_TYPE, "ProviderListing");
    assert.deepEqual(PROVIDER_LISTING_TYPES, handBuilt(14).types);
    assert.throws(
      () => providerListingTypedData({ message, chain: "eip155:1" as "eip155:14" }),
      /eip155:14/,
    );
  });

  test("info builder uses the shared typed data", () => {
    const info: Partial<ProviderInfo> = {
      name: message.name,
      description: message.description,
      websiteURL: message.websiteURL,
      logoHash: message.logoHash.slice(2),
      links: { github: "https://github.com/bifrostwallet" },
      identityAddress: message.identityAddress,
      acknowledgedResponsibilities: true,
    };
    const typed = providerListingTypedDataFromInfo(info, 19);
    assert.deepEqual(providerListingTypedData({ message: typed.message, chain: "eip155:19" }), {
      domain: typed.domain,
      types: typed.types,
      primaryType: typed.primaryType,
      message: typed.message,
    });
    assert.equal(typed.contentHash, typed.message.contentHash);
    assert.equal(typed.domain.salt, EIP712_DOMAIN_SALT);
  });

  test("viem recovers a signature over the helper", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const signedMessage = {
      ...message,
      identityAddress: account.address,
    };
    const typed = providerListingTypedData({ message: signedMessage, chain: "eip155:14" });
    const signature = await account.signTypedData(typed);
    const recovered = await recoverTypedDataAddress({ ...typed, signature });
    assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
    assert.equal(await verifyTypedData({ address: account.address, ...typed, signature }), true);

    const recoverable = {
      ...providerListingTypedData({ message, chain: "eip155:14" }),
      signature,
    } satisfies Parameters<typeof recoverTypedDataAddress>[0];
    assert.equal(recoverable.primaryType, "ProviderListing");
  });
});

describe("published ProviderListing typed data", { concurrency: false }, () => {
  test("package entry exports the shared helper", () => {
    const release = holdPackageDist();
    try {
      buildPackage();
      const indexPath = path.join(process.cwd(), "dist", "index.js");
      const require = createRequire(path.join(process.cwd(), "package.json"));
      delete require.cache[indexPath];
      const published = require(indexPath) as {
        EIP712_DOMAIN_SALT: string;
        PROVIDER_LISTING_PRIMARY_TYPE: string;
        PROVIDER_LISTING_TYPES: typeof PROVIDER_LISTING_TYPES;
        providerListingTypedData: (options: {
          message: typeof message;
          chain: "eip155:14" | "eip155:19";
        }) => ReturnType<typeof providerListingTypedData>;
      };
      assert.equal(published.EIP712_DOMAIN_SALT, EIP712_DOMAIN_SALT);
      assert.equal(published.PROVIDER_LISTING_PRIMARY_TYPE, PROVIDER_LISTING_PRIMARY_TYPE);
      assert.deepEqual(published.PROVIDER_LISTING_TYPES, PROVIDER_LISTING_TYPES);
      assert.equal("providerListingDomain" in published, false);
      assert.deepEqual(
        published.providerListingTypedData({ message, chain: "eip155:14" }),
        providerListingTypedData({ message, chain: "eip155:14" }),
      );
      assert.deepEqual(
        published.providerListingTypedData({ message, chain: "eip155:19" }),
        providerListingTypedData({ message, chain: "eip155:19" }),
      );

      const indexSource = fs.readFileSync(indexPath, "utf8");
      assert.equal(indexSource.includes(EIP712_DOMAIN_SALT), true);
      assert.equal(indexSource.includes("keccak256"), false);
      assert.equal(indexSource.includes("viem"), false);
      const dts = fs.readFileSync(path.join(process.cwd(), "dist", "index.d.ts"), "utf8");
      assert.match(dts, /readonly name: "contentHash"; readonly type: "bytes32"/);
      assert.equal(dts.includes("providerListingDomain"), false);
    } finally {
      release();
    }
  });

  test("verifies a catalog signature and rejects a tampered message", async () => {
    const release = holdPackageDist();
    try {
      buildPackage();
      const signaturesPath = path.join(process.cwd(), "dist", "signatures.js");
      const require = createRequire(path.join(process.cwd(), "package.json"));
      delete require.cache[signaturesPath];
      const { getProviderListingVerification } = require(signaturesPath) as {
        getProviderListingVerification: (
          chain: "eip155:14" | "eip155:19",
          identityAddress: string,
        ) => Array<Parameters<typeof verifyTypedData>[0]>;
      };
      const identity = "0x1650d2760baee638c034200dedcbe17b050d0364";
      const [entry] = getProviderListingVerification("eip155:14", identity);
      assert.ok(entry);
      assert.equal(await verifyTypedData(entry), true);
      assert.equal(
        await verifyTypedData({
          ...entry,
          message: { ...entry.message, name: "Tampered" },
        }),
        false,
      );
      assert.deepEqual(
        getProviderListingVerification("eip155:14", "0x1111111111111111111111111111111111111111"),
        [],
      );
      const declarations = fs.readFileSync(
        path.join(process.cwd(), "dist", "signatures.d.ts"),
        "utf8",
      );
      assert.match(declarations, /export declare function getProviderListingVerification\(/);
      const source = fs.readFileSync(signaturesPath, "utf8");
      assert.equal(source.includes("keccak256"), false);
      assert.equal(source.includes("viem"), false);
    } finally {
      release();
    }
  });
});
