import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import {
  canonicalManifestBody,
  rollupChainHashes,
  sha256Hex,
  signManifestBody,
  verifyManifest,
} from "../src/manifest.js";

describe("manifest", () => {
  it("rolls up chain hashes deterministically", () => {
    const a = rollupChainHashes({ "eip155-19": "bb", "eip155-14": "aa" });
    const b = rollupChainHashes({ "eip155-14": "aa", "eip155-19": "bb" });
    assert.equal(a, b);
    assert.equal(a, sha256Hex("eip155-14:aa\neip155-19:bb"));
  });

  it("canonical body ignores signature and sorts keys", () => {
    const body = {
      generatedAt: "2026-07-22T00:00:00.000Z",
      sections: {
        providers: {
          contentHash: "abc",
          chains: { "eip155-19": "y", "eip155-14": "x" },
        },
      },
    };
    assert.equal(
      canonicalManifestBody(body),
      JSON.stringify({
        generatedAt: "2026-07-22T00:00:00.000Z",
        sections: {
          providers: {
            contentHash: "abc",
            chains: { "eip155-14": "x", "eip155-19": "y" },
          },
        },
      }),
    );
  });

  it("signs and verifies with node:crypto Ed25519", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    process.env.ASSETS_MANIFEST_PRIVATE_KEY = privatePem;

    const body = {
      generatedAt: "2026-07-22T00:00:00.000Z",
      sections: {
        providers: { contentHash: "abc", chains: { "eip155-14": "x" } },
      },
    };
    const signed = signManifestBody(body);
    assert.ok(signed.signature.length > 0);
    assert.equal(verifyManifest(signed, publicPem), true);

    const tampered = { ...signed, generatedAt: "1999-01-01T00:00:00.000Z" };
    assert.equal(verifyManifest(tampered, publicPem), false);
  });
});
