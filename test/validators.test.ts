import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import buildPackage, { holdPackageDist } from "../src/script/packageBuild.js";

interface ValidatorInfo {
  nodeId: string;
  identityAddress: string;
  name: string;
  logoURL: string;
}

interface ProviderInfo {
  name: string;
  identityAddress: string;
  listed: boolean;
  validators: string[];
  logoURL: string;
}

interface PackageAssets {
  getProviders: (chainId: string) => ProviderInfo[];
  getListedProviders: (chainId: string) => ProviderInfo[];
  getValidators: (chainId: string) => ValidatorInfo[];
  getListedValidators: (chainId: string) => ValidatorInfo[];
  getValidatorsByIdentity: (chainId: string, identityAddress: string) => ValidatorInfo[];
  findProviderByValidator: (chainId: string, nodeId: string) => ProviderInfo | null;
}

function loadBuiltPackage(): PackageAssets {
  buildPackage();
  const indexPath = path.join(process.cwd(), "dist", "index.js");
  const require = createRequire(path.join(process.cwd(), "package.json"));
  delete require.cache[indexPath];
  const published = require(indexPath) as {
    createAssets: (options: { baseURL: string }) => PackageAssets;
  };
  return published.createAssets({ baseURL: "https://cdn.example.com/assets/" });
}

function validatorsOf(providers: ProviderInfo[]): ValidatorInfo[] {
  const list: ValidatorInfo[] = [];
  for (const provider of providers) {
    for (const nodeId of provider.validators) {
      list.push({
        nodeId,
        identityAddress: provider.identityAddress,
        name: provider.name,
        logoURL: provider.logoURL,
      });
    }
  }
  return list;
}

describe("published validator lists", { concurrency: false }, () => {
  let assets: PackageAssets;
  let releaseDist: (() => void) | undefined;
  const chainId = "eip155:14";

  before(() => {
    releaseDist = holdPackageDist();
    assets = loadBuiltPackage();
  });

  after(() => {
    releaseDist?.();
  });

  test("groups validators in getProviders order", () => {
    const providers = assets.getProviders(chainId);
    const validators = assets.getValidators(chainId);
    assert.deepEqual(validators, validatorsOf(providers));
    assert.ok(validators.length > 0);
    const grouped = new Map<string, string[]>();
    for (const validator of validators) {
      const nodeIds = grouped.get(validator.identityAddress) ?? [];
      nodeIds.push(validator.nodeId);
      grouped.set(validator.identityAddress, nodeIds);
    }
    const providerOrder = providers
      .filter((provider) => provider.validators.length > 0)
      .map((provider) => provider.identityAddress);
    assert.deepEqual([...grouped.keys()], providerOrder);
    for (const provider of providers) {
      assert.deepEqual(grouped.get(provider.identityAddress) ?? [], provider.validators);
    }
    assert.deepEqual(Object.keys(validators[0] ?? {}), [
      "nodeId",
      "identityAddress",
      "name",
      "logoURL",
    ]);
  });

  test("listed validators are only those of listed providers", () => {
    const listed = assets.getListedValidators(chainId);
    assert.deepEqual(listed, validatorsOf(assets.getListedProviders(chainId)));
    const listedIds = new Set(
      assets.getListedProviders(chainId).map((provider) => provider.identityAddress),
    );
    assert.ok(listed.every((validator) => listedIds.has(validator.identityAddress)));
    const unlistedNodeIds = assets
      .getProviders(chainId)
      .filter((provider) => !provider.listed)
      .flatMap((provider) => provider.validators);
    for (const nodeId of unlistedNodeIds) {
      assert.equal(
        listed.some((validator) => validator.nodeId === nodeId),
        false,
        nodeId,
      );
    }
  });

  test("identity lookup is case-insensitive and unknown identities are empty", () => {
    const provider = assets.getProviders(chainId).find((entry) => entry.validators.length > 0);
    assert.ok(provider);
    const expected = validatorsOf([provider]);
    assert.deepEqual(assets.getValidatorsByIdentity(chainId, provider.identityAddress), expected);
    assert.deepEqual(
      assets.getValidatorsByIdentity(chainId, provider.identityAddress.toUpperCase()),
      expected,
    );
    assert.deepEqual(
      assets.getValidatorsByIdentity(chainId, "0x1111111111111111111111111111111111111111"),
      [],
    );
    const owner = assets.findProviderByValidator(chainId, provider.validators[0] ?? "");
    assert.equal(owner?.identityAddress, provider.identityAddress);
  });

  test("a chain with no validators returns an empty list", () => {
    assert.deepEqual(assets.getValidators("eip155:19"), []);
    assert.deepEqual(assets.getListedValidators("eip155:19"), []);
    assert.deepEqual(
      assets.getValidatorsByIdentity("eip155:19", "0x7429e0c70306834e2b210cf3feb306342f456ce7"),
      [],
    );
  });
});
