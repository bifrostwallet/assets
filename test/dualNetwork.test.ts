import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  DUAL_NETWORK_GRANDFATHERED_FILE,
  type DualNetworkProvider,
  type DualNetworkReason,
  dualNetworkForProvider,
  dualNetworkMatch,
  FLARE_CHAIN_PATH,
  type GrandfatherSource,
  readGrandfatheredIdentities,
  SONGBIRD_CHAIN_PATH,
  selectGrandfatheredIdentities,
} from "../src/script/syncDualNetwork.js";

function address(byte: string): string {
  return `0x${byte.repeat(20)}`;
}

function provider(byte: string, websiteURL: string, domainLinked: boolean): DualNetworkProvider {
  return { identityAddress: address(byte), websiteURL, domainLinked };
}

function source(
  byte: string,
  name: string,
  listed: boolean,
  dualNetwork: boolean,
): GrandfatherSource {
  return { identityAddress: address(byte), name, listed, dualNetwork };
}

describe("dual network matcher", () => {
  test("the same identity address on both chains is dual", () => {
    const flare = provider("aa", "https://flare.example", false);
    const songbird = provider("aa", "https://songbird.example", false);
    songbird.identityAddress = flare.identityAddress.toUpperCase();

    assert.equal(dualNetworkMatch(flare, [songbird], new Set()), "identity");
    assert.equal(dualNetworkMatch(songbird, [flare], new Set()), "identity");
  });

  test("the same website domain linked on both chains is dual", () => {
    const flare = provider("aa", "https://www.Example.com/flare", true);
    const songbird = provider("bb", "https://example.com/songbird", true);

    assert.equal(dualNetworkMatch(flare, [songbird], new Set()), "linked-domain");
    assert.equal(dualNetworkMatch(songbird, [flare], new Set()), "linked-domain");
  });

  test("a shared domain linked on only one chain is not dual", () => {
    const linked = provider("aa", "https://example.com/docs", true);
    const unlinked = provider("bb", "https://www.example.com", false);

    assert.equal(dualNetworkMatch(linked, [unlinked], new Set()), null);
    assert.equal(dualNetworkMatch(unlinked, [linked], new Set()), null);
  });

  test("different identity and domain is not dual", () => {
    const flare = provider("aa", "https://flare.example", true);
    const songbird = provider("bb", "https://songbird.example", true);

    assert.equal(dualNetworkMatch(flare, [songbird], new Set()), null);
  });

  test("a shared name is not itself a dual-network match", () => {
    const flare = provider("aa", "https://shared.example", false);
    const songbird = provider("bb", "https://other.example", false);

    assert.equal(dualNetworkMatch(flare, [songbird], new Set()), null);
  });

  test("a provider on only one chain is not dual", () => {
    const flare = provider("aa", "https://only.example", true);
    const empty = new Set<string>();

    assert.equal(dualNetworkMatch(flare, [], empty), null);
    assert.equal(dualNetworkForProvider(FLARE_CHAIN_PATH, flare, [flare], [], empty), null);
    assert.equal(dualNetworkForProvider(SONGBIRD_CHAIN_PATH, flare, [], [flare], empty), null);
  });

  test("another chain stays false even when the identity is snapshotted", () => {
    const flare = provider("aa", "https://only.example", true);
    const grandfathered = new Set([flare.identityAddress]);

    assert.equal(dualNetworkForProvider("eip155-1", flare, [flare], [], grandfathered), null);
  });

  test("a snapshotted identity stays dual with no counterpart on the other chain", () => {
    const flare = provider("aa", "https://only.example", false);
    const grandfathered = new Set([flare.identityAddress]);

    const reason: DualNetworkReason | null = dualNetworkMatch(flare, [], grandfathered);
    assert.equal(reason, "grandfathered");
    assert.equal(
      dualNetworkForProvider(FLARE_CHAIN_PATH, flare, [flare], [], grandfathered),
      "grandfathered",
    );
  });
});

describe("grandfather snapshot selection", () => {
  test("selects listed dual providers that share a normalized name", () => {
    const flare = [source("aa", "Alpha   Node", true, true)];
    const songbird = [source("bb", "alpha node", true, true)];

    assert.deepEqual(selectGrandfatheredIdentities(flare, songbird), [
      address("aa"),
      address("bb"),
    ]);
  });

  test("a name match with only one side listed is not snapshotted", () => {
    const flare = [source("aa", "Alpha", true, true)];
    const songbird = [source("bb", "Alpha", false, true)];

    assert.deepEqual(selectGrandfatheredIdentities(flare, songbird), []);
  });

  test("an existing false value is not snapshotted from a name match", () => {
    const flare = [source("aa", "Alpha", true, false)];
    const songbird = [source("bb", "Alpha", true, true)];

    assert.deepEqual(selectGrandfatheredIdentities(flare, songbird), [address("bb")]);
  });

  test("an empty name does not match", () => {
    const flare = [source("aa", "   ", true, true)];
    const songbird = [source("bb", "", true, true)];

    assert.deepEqual(selectGrandfatheredIdentities(flare, songbird), []);
  });

  test("the committed snapshot is a sorted list of identity addresses", () => {
    const filePath = path.join(process.cwd(), DUAL_NETWORK_GRANDFATHERED_FILE);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { identities: string[] };
    const identities = readGrandfatheredIdentities(filePath);

    assert.ok(identities.size > 0);
    assert.deepEqual(raw.identities, [...raw.identities].sort());
    assert.equal(identities.size, raw.identities.length);
    for (const identity of raw.identities) {
      assert.equal(identity, identity.toLowerCase());
      assert.equal(identities.has(identity), true);
    }
  });
});
