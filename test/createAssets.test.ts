import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import buildPackage, { holdPackageDist } from "../src/script/packageBuild.js";

interface LogoRecord {
  logoURL: string;
  address?: string | null;
  identityAddress?: string;
  listed?: boolean;
  issuer?: string;
  currency?: string;
}

interface DappChip {
  id: string;
  label: string;
  dapps: string[];
}

interface Assets {
  getListedProviders: (chainId: string) => LogoRecord[];
  getProvider: (chainId: string, identityAddress: string) => LogoRecord | null;
  getToken: (chainId: string, address: string) => LogoRecord | null;
  getTokens: (chainId: string) => LogoRecord[];
  getNativeToken: (chainId: string) => LogoRecord | null;
  getXrplToken: (issuer: string, currency: string) => LogoRecord | null;
  getContract: (chainId: string, address: string) => LogoRecord | null;
  getContracts: (chainId?: string) => LogoRecord[];
  getDappCategories: () => DappChip[];
}

const GETTERS = [
  "findProviderByValidator",
  "getContract",
  "getContracts",
  "getDappCategories",
  "getListedProviders",
  "getListedValidators",
  "getManagementGroupProviders",
  "getNativeToken",
  "getProvider",
  "getProviders",
  "getToken",
  "getTokens",
  "getValidators",
  "getValidatorsByIdentity",
  "getXrplToken",
];

type CreateAssets = (options?: { baseURL?: string } | null) => Assets;

function readDistJson<T>(relativePath: string): T {
  const fullPath = path.join(process.cwd(), "dist", relativePath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8")) as T;
}

describe("createAssets", { concurrency: false }, () => {
  let createAssets: CreateAssets;
  let releaseDist: (() => void) | undefined;

  before(() => {
    releaseDist = holdPackageDist();
    buildPackage();
    const indexPath = path.join(process.cwd(), "dist", "index.js");
    const require = createRequire(path.join(process.cwd(), "package.json"));
    delete require.cache[indexPath];
    createAssets = (require(indexPath) as { createAssets: CreateAssets }).createAssets;
  });

  after(() => {
    releaseDist?.();
  });

  test("resolves provider, token, contract, and dapp logos", () => {
    const base = "https://cdn.example.com/assets";
    const assets = createAssets({ baseURL: base });
    const prefix = "https://cdn.example.com/assets/";
    assert.deepEqual(Object.keys(assets).sort(), GETTERS);

    const require = createRequire(path.join(process.cwd(), "package.json"));
    const storedProviders = require(
      path.join(process.cwd(), "dist", "providers", "eip155-14.json"),
    ) as LogoRecord[];
    const stored = storedProviders.find((provider) => provider.listed);
    assert.ok(stored);
    assert.ok(stored.logoURL.startsWith("providers/"));
    const listed = assets.getListedProviders("eip155:14");
    assert.equal(listed[0]?.logoURL, `${prefix}${stored.logoURL}`);
    assert.deepEqual(Object.keys(listed[0] ?? {}).sort(), Object.keys(stored).sort());
    assert.equal(stored.logoURL.startsWith("providers/"), true);
    const provider = assets.getProvider("eip155:14", stored.identityAddress ?? "");
    assert.equal(provider?.logoURL, listed[0]?.logoURL);
    assert.equal(
      assets.getProvider("eip155:14", "0x1111111111111111111111111111111111111111"),
      null,
    );

    const flareTokens = readDistJson<LogoRecord[]>("tokens/eip155-14.json");
    const wrapped = flareTokens.find((token) => token.address);
    assert.ok(wrapped?.address);
    assert.equal(
      assets.getToken("eip155:14", wrapped.address)?.logoURL,
      `${prefix}${wrapped.logoURL}`,
    );
    const native = flareTokens.find((token) => token.address === null);
    assert.ok(native);
    assert.equal(assets.getNativeToken("eip155:14")?.logoURL, `${prefix}${native.logoURL}`);
    assert.match(native.logoURL, /^tokens\//);

    const xrplTokens = readDistJson<LogoRecord[]>("tokens/xrpl-0.json");
    const issued = xrplTokens[0];
    assert.ok(issued?.issuer && issued.currency);
    assert.equal(
      assets.getXrplToken(issued.issuer, issued.currency)?.logoURL,
      `${prefix}${issued.logoURL}`,
    );

    const flareContracts = readDistJson<LogoRecord[]>("contracts/eip155-14.json");
    const contract = flareContracts[0];
    assert.ok(contract?.address);
    assert.match(contract.logoURL, /^contracts\//);
    assert.equal(
      assets.getContract("eip155:14", contract.address)?.logoURL,
      `${prefix}${contract.logoURL}`,
    );
    assert.ok(
      assets.getContracts().every((entry) => entry.logoURL.startsWith(`${prefix}contracts/`)),
    );
    assert.equal(
      assets.getContract("eip155:14", "0x0000000000000000000000000000000000000001"),
      null,
    );

    const categories = readDistJson<DappChip[]>("dapps/categories.json");
    assert.deepEqual(assets.getDappCategories(), categories);
    const dex = categories.find((chip) => chip.id === "dex");
    assert.ok(dex);
    assert.ok(dex.dapps.includes("sparkdex-ai"));
    assert.equal(
      dex.dapps.some((slug) => slug.includes("://")),
      false,
    );
  });

  test("omitted baseURL uses jsDelivr for this package version", () => {
    const version = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"))
      .version as string;
    const prefix = `https://cdn.jsdelivr.net/gh/bifrostwallet/assets@v${version}/data/`;
    const assets = createAssets();
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const storedProviders = require(
      path.join(process.cwd(), "dist", "providers", "eip155-14.json"),
    ) as LogoRecord[];
    const stored = storedProviders.find((provider) => provider.listed);
    assert.ok(stored?.logoURL.startsWith("providers/"));
    assert.equal(assets.getListedProviders("eip155:14")[0]?.logoURL, `${prefix}${stored?.logoURL}`);
    assert.equal(fs.existsSync(path.join(process.cwd(), "data", stored?.logoURL ?? "")), true);
    const indexSource = fs.readFileSync(path.join(process.cwd(), "dist", "index.js"), "utf8");
    assert.equal(indexSource.includes(prefix), true);
    assert.equal(indexSource.includes("raw.githubusercontent.com"), false);
    assert.equal(indexSource.includes("@main/"), false);
    assert.equal(indexSource.includes("package.json"), false);
    assert.equal(indexSource.includes("readFileSync"), false);
    const custom = createAssets({ baseURL: "https://assets.example.com" });
    assert.equal(
      custom.getListedProviders("eip155:14")[0]?.logoURL,
      `https://assets.example.com/${stored?.logoURL}`,
    );
  });

  test("an invalid baseURL throws and an omitted one does not", () => {
    assert.doesNotThrow(() => createAssets());
    assert.doesNotThrow(() => createAssets({}));
    assert.throws(() => createAssets({ baseURL: "" }), /https:\/\//);
    assert.throws(() => createAssets({ baseURL: "http://cdn.example.com/assets/" }), /https:\/\//);
    assert.throws(() => createAssets({ baseURL: "cdn.example.com/assets" }), /https:\/\//);
  });

  test("two instances with different bases do not interfere", () => {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const storedProviders = require(
      path.join(process.cwd(), "dist", "providers", "eip155-14.json"),
    ) as LogoRecord[];
    const relative = storedProviders.find((provider) => provider.listed)?.logoURL;
    assert.ok(relative?.startsWith("providers/"));
    assert.ok(relative);

    const a = createAssets({ baseURL: "https://cdn.example.com/a" });
    const b = createAssets({ baseURL: "https://cdn.example.com/b/" });
    const aLogo = a.getListedProviders("eip155:14")[0]?.logoURL;
    const bLogo = b.getListedProviders("eip155:14")[0]?.logoURL;
    assert.equal(aLogo, `https://cdn.example.com/a/${relative}`);
    assert.equal(bLogo, `https://cdn.example.com/b/${relative}`);
    assert.equal(a.getListedProviders("eip155:14")[0]?.logoURL, aLogo);
    assert.equal(
      b.getProvider(
        "eip155:14",
        storedProviders.find((provider) => provider.listed)?.identityAddress ?? "",
      )?.logoURL,
      bLogo,
    );
    assert.equal(storedProviders.find((provider) => provider.listed)?.logoURL, relative);

    const token = readDistJson<LogoRecord[]>("tokens/eip155-14.json").find(
      (entry) => entry.address,
    );
    assert.ok(token?.address);
    assert.equal(
      a.getToken("eip155:14", token.address)?.logoURL,
      `https://cdn.example.com/a/${token.logoURL}`,
    );
    assert.equal(
      b.getToken("eip155:14", token.address)?.logoURL,
      `https://cdn.example.com/b/${token.logoURL}`,
    );
  });
});
