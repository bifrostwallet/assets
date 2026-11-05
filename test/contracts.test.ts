import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, test } from "node:test";
import { resolveAssetURL, toRelativeAssetPath } from "../src/assetUrl.js";
import { DAPP_CATEGORIES, DAPP_CATEGORY_LABELS } from "../src/config.js";
import {
  CONTRACT_CATEGORIES,
  CONTRACT_CATEGORY_LABELS,
  type ContractInfo,
  getContract,
  getContracts,
  validateContractCatalog,
  validateContractRecord,
} from "../src/contracts.js";
import buildPackage from "../src/script/packageBuild.js";
import type { EvmToken } from "../src/tokens.js";
import type { XrplToken } from "../src/xrplToken.js";

const BIFROST_POOL = "0x3a06584a47972ff7005301b5a44c7d2214a4d3b4";
const BIFROST_DAPP = "bifrostwallet-com";

describe("contract catalog", { concurrency: false }, () => {
  test("data/contracts matches the schema", () => {
    const errors = validateContractCatalog();
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  test("seed covers pools, vaults, and Firelight", () => {
    const all = getContracts();
    const count = (category: ContractInfo["category"]) =>
      all.filter((contract) => contract.category === category).length;
    assert.deepEqual(CONTRACT_CATEGORIES, [
      "dex",
      "aggregator",
      "bridge",
      "lending",
      "staking",
      "yield",
      "perpetuals",
      "predictions",
      "nft-marketplace",
      "governance",
      "fassets",
      "rewards",
      "other",
    ]);
    assert.equal(count("dex"), 9);
    assert.equal(count("aggregator"), 0);
    assert.equal(count("bridge"), 3);
    assert.equal(count("lending"), 6);
    assert.equal(count("staking"), 1);
    assert.equal(count("yield"), 4);
    assert.equal(count("perpetuals"), 0);
    assert.equal(count("predictions"), 0);
    assert.equal(count("nft-marketplace"), 0);
    assert.equal(count("governance"), 0);
    assert.equal(count("fassets"), 22);
    assert.equal(count("rewards"), 6);
    assert.equal(count("other"), 0);
    assert.equal(all.length, 51);
    const logoByProject = new Map<string, string>();
    for (const contract of all) {
      assert.match(contract.logoURL, /^dapps\/[a-z0-9-]+\/logo\.webp$/);
      assert.match(contract.logoHash, /^[0-9a-f]{64}$/);
      const previous = logoByProject.get(contract.projectName);
      if (previous === undefined) logoByProject.set(contract.projectName, contract.logoHash);
      else assert.equal(contract.logoHash, previous, contract.projectName);
    }
    assert.equal(logoByProject.size, 15);
    for (const category of CONTRACT_CATEGORIES) {
      assert.equal(CONTRACT_CATEGORY_LABELS[category].length > 0, true);
    }
  });

  test("getContract is case-insensitive and getContracts filters by CAIP-2", () => {
    const lower = getContract("eip155:14", BIFROST_POOL);
    const checksum = getContract("eip155:14", "0x3A06584A47972fF7005301b5A44c7D2214A4d3b4");
    assert.ok(lower);
    assert.deepEqual(checksum, lower);
    assert.equal(lower.projectName, "Bifrost Wallet");
    assert.equal(lower.contractName, "Collateral Pool");
    assert.equal(lower.category, "fassets");
    assert.equal(lower.chain, "eip155:14");
    assert.equal(lower.logoURL, `dapps/${BIFROST_DAPP}/logo.webp`);
    assert.equal(lower.logoHash, sha256File(path.join(process.cwd(), "data", lower.logoURL)));
    assert.equal(getContract("eip155:14", "0x5ed8551f90acc6395810d8274b019bf13ef1f696"), null);

    const auPool = getContract("eip155:14", "0xf45c1a5Ef4fB09F1c33f772175b2fec229D1885B");
    assert.equal(auPool?.projectName, "AU");
    assert.equal(auPool?.contractName, "Collateral Pool");
    assert.equal(auPool?.logoURL, "dapps/au-cc/logo.webp");

    const firelight = getContract("eip155:114", "0x8371172AB47A594592625C8e8FfFEF956a9acC1a");
    assert.equal(firelight?.projectName, "Firelight");
    assert.equal(firelight?.contractName, "Vault");
    assert.equal(firelight?.category, "staking");
    assert.equal(firelight?.logoURL, "dapps/firelight-finance/logo.webp");
    assert.equal(getContract("eip155:114", "0xc90d6847747b85d1fa2e07859869fb9fb72c0361"), null);
    assert.equal(getContracts("eip155:14").length, 35);
    assert.equal(getContracts("eip155:19").length, 15);
    assert.equal(getContracts("eip155:114").length, 1);

    assert.equal(getContract("eip155:14", "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d"), null);
    assert.equal(getContract("eip155:19", "0x02f0826ef6aD107Cfc861152B32B52fD11BaB9ED"), null);
    assert.equal(getContract("eip155:14", "0x12e605bc104e93B45e1aD99F9e555f659051c2BB"), null);
    const spark = getContract("eip155:14", "0x0f3D8a38D4c74afBebc2c42695642f0e3acb15D3");
    assert.equal(spark?.projectName, "SparkDEX");
    assert.equal(spark?.category, "dex");
    assert.equal(spark?.logoURL, "dapps/sparkdex-ai/logo.webp");
    const unitroller = getContract("eip155:14", "0x8041680Fb73E1Fe5F851e76233DCDfA0f2D2D7c8");
    assert.equal(unitroller?.projectName, "Kinetic");
    assert.equal(unitroller?.contractName, "Unitroller");
    const endpoint = getContract("eip155:14", "0x1a44076050125825900e736c501f859c50fE728c");
    assert.equal(endpoint?.projectName, "LayerZero");
    assert.equal(endpoint?.category, "bridge");
    const enosys = getContract("eip155:14", "0x5FD34090E9b195d8482Ad3CC63dB078534F1b113");
    assert.equal(enosys?.projectName, "Enosys");
    assert.equal(enosys?.contractName, "Swap Router");
    const morpho = getContract("eip155:14", "0xF4346F5132e810f80a28487a79c7559d9797E8B0");
    assert.equal(morpho?.projectName, "Morpho");
    assert.equal(morpho?.category, "lending");
    const spectra = getContract("eip155:14", "0x03E2eC137c6aB82978D52eDB7b504ad2DEb13F96");
    assert.equal(spectra?.projectName, "Spectra");
    assert.equal(spectra?.contractName, "Router");
    assert.throws(() => getContracts("eip155:16"), /Unknown contract chain/);

    assert.equal(getContract("eip155:14", "0x0000000000000000000000000000000000000001"), null);
    const flare = getContracts("eip155:14");
    assert.ok(flare.every((contract) => contract.chain === "eip155:14"));
    assert.ok(getContracts().length > flare.length);
    assert.throws(() => getContracts("eip155:1"), /Unknown contract chain/);
    assert.throws(() => getContracts("eip155-14"), /CAIP-2/);
  });

  test("getContract returns chain from the directory", () => {
    const file = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "data", "contracts", "eip155-14", `${BIFROST_POOL}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    assert.equal(Object.hasOwn(file, "chain"), false);
    assert.equal(Object.hasOwn(file, "projectName"), false);
    assert.equal(Object.hasOwn(file, "project"), false);
    assert.equal(file.dapp, BIFROST_DAPP);
    assert.equal(file.address, BIFROST_POOL);
    assert.equal(file.logoURL, `dapps/${BIFROST_DAPP}/logo.webp`);
    const dapp = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "data", "dapps", BIFROST_DAPP, "info.json"), "utf8"),
    ) as { title: string; logoURL: string; logoHash: string };
    assert.equal(file.logoURL, dapp.logoURL);
    assert.equal(file.logoHash, dapp.logoHash);
    assert.equal(dapp.title, "Bifrost Wallet");
    const contract = getContract("eip155:14", BIFROST_POOL);
    assert.ok(contract);
    assert.equal(contract.chain, "eip155:14");
    assert.equal(contract.address, BIFROST_POOL);
    const songbird = getContracts("eip155:19");
    assert.ok(songbird.every((entry) => entry.chain === "eip155:19"));
    assert.equal(
      songbird.some(
        (entry) => entry.projectName === "Songbird" || entry.logoURL.includes("songbird"),
      ),
      false,
    );
    assert.ok(songbird.some((entry) => entry.projectName === "Flare"));
    const flareReward = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          "data/contracts/eip155-19/0x1643299dbbb36e3e1ac26a7febc3f97382bdcfa5.json",
        ),
        "utf8",
      ),
    ) as { dapp: string; logoURL: string };
    assert.equal(flareReward.dapp, "flare-network");
    assert.equal(flareReward.logoURL, "dapps/flare-network/logo.webp");
    assert.equal(
      getContract("eip155:114", "0x8371172AB47A594592625C8e8FfFEF956a9acC1a")?.chain,
      "eip155:114",
    );
  });

  test("rejects a non-lowercase address, a bad category, and a stored chain", () => {
    const dapp = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "data", "dapps", BIFROST_DAPP, "info.json"), "utf8"),
    ) as { logoURL: string; logoHash: string };
    const base = {
      address: BIFROST_POOL,
      dapp: BIFROST_DAPP,
      contractName: "Collateral Pool",
      category: "fassets",
      logoURL: dapp.logoURL,
      logoHash: dapp.logoHash,
    };
    const ctx = { chainPath: "eip155-14", fileName: `${BIFROST_POOL}.json` };
    assert.deepEqual(
      validateContractRecord(
        { ...base, address: "0x3A06584A47972fF7005301b5A44c7D2214A4d3b4" },
        ctx,
      ).some((error) => error.includes("lowercase")),
      true,
    );
    assert.deepEqual(
      validateContractRecord({ ...base, category: "router" }, ctx).some((error) =>
        error.includes("category"),
      ),
      true,
    );
    assert.deepEqual(
      validateContractRecord({ ...base, category: "aggregator", contractName: "Aggregator" }, ctx),
      [],
    );
    assert.deepEqual(
      validateContractRecord({ ...base, chain: "eip155:14" }, ctx).some((error) =>
        error.includes("must not be stored"),
      ),
      true,
    );
    assert.deepEqual(
      validateContractRecord({ ...base, projectName: "Bifrost Wallet" }, ctx).some((error) =>
        error.includes("projectName"),
      ),
      true,
    );
    assert.deepEqual(
      validateContractRecord({ ...base, logoHash: "a".repeat(64) }, ctx).some((error) =>
        error.includes("must match dapp"),
      ),
      true,
    );
    assert.deepEqual(
      validateContractRecord({ ...base, dapp: "missing-dapp" }, ctx).some((error) =>
        error.includes("unknown dapp"),
      ),
      true,
    );
    assert.deepEqual(
      validateContractRecord({ ...base, listed: true }, ctx).some((error) =>
        error.includes("unexpected field"),
      ),
      true,
    );
  });
});

describe("published package lookups", { concurrency: false }, () => {
  test("getContract and getContracts match the catalog", () => {
    buildPackage();
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const assets = require(path.join(process.cwd(), "dist/index.js")) as {
      getContract: (chainId: string, address: string) => ContractInfo | null;
      getContracts: (chainId?: string) => ContractInfo[];
      CONTRACT_CHAIN_IDS: string[];
      CONTRACT_CATEGORIES: readonly string[];
      CONTRACT_CATEGORY_LABELS: Record<string, string>;
    };
    const fromPackage = assets.getContract(
      "eip155:14",
      "0x3A06584A47972fF7005301b5A44c7D2214A4d3b4",
    );
    const fromCatalog = getContract("eip155:14", BIFROST_POOL);
    assert.ok(fromPackage?.logoURL);
    assert.ok(fromCatalog?.logoURL);
    assert.equal(fromPackage.logoURL, toRelativeAssetPath(fromCatalog.logoURL));
    assert.equal(/^https?:\/\//i.test(fromPackage.logoURL), false);
    const { logoURL: _packageLogo, ...packageRest } = fromPackage;
    const { logoURL: _catalogLogo, ...catalogRest } = fromCatalog;
    assert.deepEqual(packageRest, catalogRest);
    assert.equal(assets.getContracts().length, getContracts().length);
    assert.ok(assets.CONTRACT_CHAIN_IDS.includes("eip155:14"));
    assert.deepEqual(assets.CONTRACT_CATEGORIES, [...CONTRACT_CATEGORIES]);
    assert.deepEqual(assets.CONTRACT_CATEGORY_LABELS, CONTRACT_CATEGORY_LABELS);
    const packaged = assets as typeof assets & {
      getDappCategories: () => { id: string; label: string; dapps: string[] }[];
      DAPP_CATEGORIES: readonly string[];
      DAPP_CATEGORY_LABELS: Record<string, string>;
    };
    const categoryFile = path.join(process.cwd(), "data", "dapps", "categories.json");
    const packagedFile = path.join(process.cwd(), "dist", "dapps", "categories.json");
    assert.equal(fs.existsSync(path.join(process.cwd(), "dist", "dapps", "all.json")), false);
    assert.equal(fs.readFileSync(packagedFile, "utf8"), fs.readFileSync(categoryFile, "utf8"));
    const parsedCategories = JSON.parse(fs.readFileSync(categoryFile, "utf8"));
    assert.deepEqual(packaged.getDappCategories(), parsedCategories);
    assert.deepEqual(packaged.DAPP_CATEGORIES, [...DAPP_CATEGORIES]);
    assert.deepEqual(packaged.DAPP_CATEGORY_LABELS, DAPP_CATEGORY_LABELS);
    assert.equal(
      assets.getContract("eip155:19", "0x0000000000000000000000000000000000000001"),
      null,
    );
    assert.throws(() => assets.getContracts("not-a-chain"));
  });

  test("published package keeps relative logoURL and ships no logo files", () => {
    const previousBase = process.env.ASSET_BASE_URL;
    process.env.ASSET_BASE_URL = "https://operator.example/cdn/";
    let assets: PackageAssets;
    try {
      assets = loadBuiltPackage();
    } finally {
      if (previousBase === undefined) delete process.env.ASSET_BASE_URL;
      else process.env.ASSET_BASE_URL = previousBase;
    }

    const manifest = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "dist", "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      version: string;
    };
    const root = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(manifest.version, root.version);
    assert.deepEqual(manifest.dependencies, {});
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.peerDependencies, undefined);

    const logoURLs = publishedLogoURLs(path.join(process.cwd(), "dist"));
    assert.ok(logoURLs.length > 0);
    for (const logoURL of logoURLs) {
      assert.equal(/^https?:\/\//i.test(logoURL), false, logoURL);
      assert.match(logoURL, /^(providers|tokens|dapps|contracts)\//);
    }

    const bifrost = assets.getProvider("eip155:14", "0x1650d2760baee638c034200dedcbe17b050d0364");
    assert.ok(bifrost);
    assert.equal(
      bifrost.logoURL,
      "providers/eip155-14/0x1650d2760baee638c034200dedcbe17b050d0364/logo.webp",
    );
    const packagedLogo = path.join(process.cwd(), "dist", bifrost.logoURL);
    const sourceLogo = path.join(process.cwd(), "data", bifrost.logoURL);
    assert.equal(fs.existsSync(sourceLogo), true);
    assert.equal(fs.existsSync(packagedLogo), false);
    assert.deepEqual(logoWebps(path.join(process.cwd(), "dist")), []);

    const wflr = assets.getToken("eip155:14", "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d");
    assert.ok(wflr);
    assert.match(wflr.logoURL, /^tokens\//);
    assert.equal(fs.existsSync(path.join(process.cwd(), "dist", wflr.logoURL)), false);

    const pool = assets.getContract("eip155:14", "0x3A06584A47972fF7005301b5A44c7D2214A4d3b4");
    assert.ok(pool);
    assert.match(pool.logoURL, /^dapps\//);
    assert.equal(fs.existsSync(path.join(process.cwd(), "dist", pool.logoURL)), false);

    const base = "https://cdn.example.com/assets";
    const joined = `https://cdn.example.com/assets/${bifrost.logoURL}`;
    assert.equal(assets.resolveAssetURL(bifrost.logoURL, base), joined);
    assert.equal(assets.resolveAssetURL(bifrost.logoURL, `${base}/`), joined);
    assert.equal(
      assets.resolveAssetURL(
        `https://raw.githubusercontent.com/bifrostwallet/assets/main/data/${bifrost.logoURL}`,
        base,
      ),
      joined,
    );
    assert.equal(
      assets.resolveAssetURL(`https://cdn.example.com/static/${bifrost.logoURL}`, base),
      joined,
    );
    assert.equal(
      assets.resolveAssetURL(`https://assets.example.com/bucket/${wflr.logoURL}?v=1`, `${base}/`),
      `https://cdn.example.com/assets/${wflr.logoURL}`,
    );
    assert.equal(
      assets.resolveAssetURL(pool.logoURL, base),
      `https://cdn.example.com/assets/${pool.logoURL}`,
    );
    const unknown = "https://images.example.com/unrelated.png";
    assert.equal(assets.resolveAssetURL(unknown, base), unknown);
    assert.equal(
      assets.resolveAssetURL(bifrost.logoURL),
      `https://raw.githubusercontent.com/bifrostwallet/assets/main/data/${bifrost.logoURL}`,
    );
    assert.equal(
      assets.resolveAssetURL(bifrost.logoURL, base),
      resolveAssetURL(bifrost.logoURL, base),
    );

    const indexSource = fs.readFileSync(path.join(process.cwd(), "dist", "index.js"), "utf8");
    assert.equal(indexSource.includes('require("./signatures'), false);
    assert.equal(Object.hasOwn(bifrost, "signatures"), false);
    const manifestWithExports = manifest as typeof manifest & {
      exports?: { "./signatures"?: { default?: string } };
    };
    assert.equal(manifestWithExports.exports?.["./signatures"]?.default, "./signatures.js");

    const signaturesPath = path.join(process.cwd(), "dist", "signatures.js");
    const packageRequire = createRequire(path.join(process.cwd(), "package.json"));
    delete packageRequire.cache[signaturesPath];
    const { getProviderSignatures } = packageRequire(signaturesPath) as {
      getProviderSignatures: (
        chainId: string,
        identityAddress: string,
      ) => { signatures: { signerAddress: string }[] } | null;
    };
    const bifrostSignatures = getProviderSignatures(
      "eip155:14",
      "0x1650d2760baee638c034200dedcbe17b050d0364",
    );
    assert.ok(bifrostSignatures);
    assert.equal(
      bifrostSignatures.signatures.some(
        (entry) =>
          entry.signerAddress.toLowerCase() === "0x1650d2760baee638c034200dedcbe17b050d0364",
      ),
      true,
    );
    assert.equal(
      getProviderSignatures("eip155:14", "0x1111111111111111111111111111111111111111"),
      null,
    );

    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: path.join(process.cwd(), "dist"),
        encoding: "utf8",
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const packedPaths = packed.flatMap((entry) => entry.files.map((file) => file.path));
    assert.equal(
      packedPaths.some((packedPath) => packedPath.endsWith("logo.webp")),
      false,
    );
    assert.equal(
      packedPaths.some((packedPath) => packedPath.endsWith("signatures.js")),
      true,
    );
    assert.equal(
      packedPaths.some((packedPath) => packedPath.endsWith("signatures.json")),
      true,
    );
  });

  test("getToken stays address-based and getXrplToken is exact-case", () => {
    buildPackage();
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const assets = require(path.join(process.cwd(), "dist/index.js")) as {
      getToken: (chainId: string, address: string) => EvmToken | null;
      getXrplToken: (issuer: string, currency: string) => XrplToken | null;
      getTokens: (chainId: string) => EvmToken[] | XrplToken[];
    };
    const issuer = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
    const currency = "524C555344000000000000000000000000000000";
    const rlusd = assets.getXrplToken(issuer, currency);
    assert.ok(rlusd);
    assert.equal(rlusd.symbol, "RLUSD");
    assert.equal(rlusd.issuer, issuer);
    assert.equal(rlusd.currency, currency);
    assert.equal(Object.hasOwn(rlusd, "address"), false);
    assert.equal(Object.hasOwn(rlusd, "decimals"), false);
    assert.equal(assets.getXrplToken(issuer.toLowerCase(), currency), null);
    assert.equal(assets.getXrplToken(issuer, currency.toLowerCase()), null);
    assert.equal(assets.getToken("xrpl:0", `${issuer}.${currency}`), null);
    const wflr = assets.getToken("eip155:14", "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d");
    assert.equal(wflr?.address, "0x1d80c49bbbcd1c0911346656b529df9e5c2f783d");
    const xrpl = assets.getTokens("xrpl:0");
    assert.equal(xrpl.length, 10);
    assert.ok(
      xrpl.every(
        (token) =>
          !Object.hasOwn(token, "address") &&
          !Object.hasOwn(token, "decimals") &&
          "issuer" in token,
      ),
    );
  });
});

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

interface PackageAssets {
  getProvider: (chainId: string, identityAddress: string) => { logoURL: string } | null;
  getToken: (chainId: string, address: string) => { logoURL: string } | null;
  getContract: (chainId: string, address: string) => { logoURL: string } | null;
  resolveAssetURL: (logoURL: string, baseURL?: string) => string;
  DEFAULT_ASSET_BASE_URL: string;
}

function loadBuiltPackage(): PackageAssets {
  buildPackage();
  const indexPath = path.join(process.cwd(), "dist", "index.js");
  const require = createRequire(path.join(process.cwd(), "package.json"));
  delete require.cache[indexPath];
  return require(indexPath) as PackageAssets;
}

function logoWebps(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.name !== "logo.webp") continue;
      found.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
}

function publishedLogoURLs(distDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.name.endsWith(".json") || entry.name === "package.json") continue;
      const parsed: unknown = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item || typeof item !== "object" || !("logoURL" in item)) continue;
        found.push(String((item as { logoURL: unknown }).logoURL));
      }
    }
  };
  walk(distDir);
  return found;
}
