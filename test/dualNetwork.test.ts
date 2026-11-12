import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type DualNetworkProvider,
  dualNetworkForProvider,
  dualNetworkMatch,
  FLARE_CHAIN_PATH,
  SONGBIRD_CHAIN_PATH,
} from "../src/script/syncDualNetwork.js";

function address(byte: string): string {
  return `0x${byte.repeat(20)}`;
}

function provider(
  byte: string,
  websiteURL: string,
  domainLinked: boolean,
  name = `Provider ${byte}`,
): DualNetworkProvider {
  return { identityAddress: address(byte), name, websiteURL, domainLinked };
}

describe("dual network matcher", () => {
  test("the same identity address on both chains is dual", () => {
    const flare = provider("aa", "https://flare.example", false);
    const songbird = provider("aa", "https://songbird.example", false, "Other name");
    songbird.identityAddress = flare.identityAddress.toUpperCase();

    assert.equal(dualNetworkMatch(flare, [songbird]), "identity");
    assert.equal(dualNetworkMatch(songbird, [flare]), "identity");
  });

  test("the same website domain linked on both chains is dual", () => {
    const flare = provider("aa", "https://www.Example.com/flare", true);
    const songbird = provider("bb", "https://example.com/songbird", true);

    assert.equal(dualNetworkMatch(flare, [songbird]), "linked-domain");
    assert.equal(dualNetworkMatch(songbird, [flare]), "linked-domain");
  });

  test("a shared domain linked on only one chain is not dual", () => {
    const linked = provider("aa", "https://example.com/docs", true);
    const unlinked = provider("bb", "https://www.example.com", false);

    assert.equal(dualNetworkMatch(linked, [unlinked]), null);
    assert.equal(dualNetworkMatch(unlinked, [linked]), null);
  });

  test("the same normalized name on both chains is dual", () => {
    const flare = provider("aa", "https://flare.example", false, "Alpha   Node");
    const songbird = provider("bb", "https://songbird.example", false, "alpha node");

    assert.equal(dualNetworkMatch(flare, [songbird]), "name");
    assert.equal(dualNetworkMatch(songbird, [flare]), "name");
  });

  test("an empty name does not match", () => {
    const flare = provider("aa", "https://a.example", true, "   ");
    const songbird = provider("bb", "https://b.example", true, "");

    assert.equal(dualNetworkMatch(flare, [songbird]), null);
  });

  test("different identity, domain, and name is not dual", () => {
    const flare = provider("aa", "https://flare.example", true);
    const songbird = provider("bb", "https://songbird.example", true);

    assert.equal(dualNetworkMatch(flare, [songbird]), null);
  });

  test("a provider on only one chain is not dual", () => {
    const flare = provider("aa", "https://only.example", true, "Only");

    assert.equal(dualNetworkMatch(flare, []), null);
    assert.equal(dualNetworkForProvider(FLARE_CHAIN_PATH, flare, [flare], []), null);
    assert.equal(dualNetworkForProvider(SONGBIRD_CHAIN_PATH, flare, [], [flare]), null);
  });

  test("another chain stays false even when the name matches", () => {
    const flare = provider("aa", "https://only.example", true, "Alpha");
    const songbird = provider("bb", "https://other.example", false, "Alpha");

    assert.equal(dualNetworkForProvider("eip155-1", flare, [flare], [songbird]), null);
  });
});
