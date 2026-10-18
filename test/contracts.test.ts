import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, test } from "node:test";
import { resolveAssetURL } from "../src/assetUrl.js";
import {
  CONTRACT_CATEGORIES,
  type ContractInfo,
  getContract,
  getContracts,
  validateContractCatalog,
  validateContractRecord,
} from "../src/contracts.js";
import buildPackage from "../src/script/packageBuild.js";

const BIFROST_POOL = "0x3a06584a47972ff7005301b5a44c7d2214a4d3b4";

describe("contract catalog", { concurrency: false }, () => {
  test("data/contracts matches the schema and all.json aggregates", () => {
    const errors = validateContractCatalog();
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  test("seed covers pools, vaults, and Firelight", () => {
    const all = getContracts();
    const count = (category: ContractInfo["category"]) =>
      all.filter((contract) => contract.category === category).length;
    assert.equal(count("aggregator"), 0);
    assert.equal(count("collateral-pool"), 10);
    assert.equal(count("agent-vault"), 10);
    assert.equal(count("staking-protocol"), 2);
    assert.equal(all.length, 22);
    assert.ok(CONTRACT_CATEGORIES.includes("aggregator"));
    assert.ok(CONTRACT_CATEGORIES.includes("router"));
    assert.ok(CONTRACT_CATEGORIES.includes("bridge"));
    assert.ok(CONTRACT_CATEGORIES.includes("dapp-contract"));
  });

  test("getContract is case-insensitive and getContracts filters by CAIP-2", () => {
    const lower = getContract("eip155:14", BIFROST_POOL);
    const checksum = getContract("eip155:14", "0x3A06584A47972fF7005301b5A44c7D2214A4d3b4");
    assert.ok(lower);
    assert.deepEqual(checksum, lower);
    assert.equal(lower.projectName, "Bifrost Wallet");
    assert.equal(lower.contractName, "Collateral Pool");
    assert.equal(lower.category, "collateral-pool");
    assert.equal(lower.chain, "eip155:14");
    assert.equal(lower.logoURL, "contracts/logos/bifrost-wallet.webp");
    assert.equal(getContract("eip155:14", "0x5ed8551f90acc6395810d8274b019bf13ef1f696"), null);

    const auPool = getContract("eip155:14", "0xf45c1a5Ef4fB09F1c33f772175b2fec229D1885B");
    assert.equal(auPool?.projectName, "AU");
    assert.equal(auPool?.contractName, "Collateral Pool");
    assert.equal(auPool?.logoURL, "contracts/logos/au.webp");

    const firelight = getContract("eip155:114", "0x8371172AB47A594592625C8e8FfFEF956a9acC1a");
    assert.equal(firelight?.projectName, "Firelight");
    assert.equal(firelight?.contractName, "Vault");
    assert.equal(firelight?.category, "staking-protocol");
    assert.equal(firelight?.logoURL, "contracts/logos/firelight.webp");
    assert.equal(getContract("eip155:114", "0xc90d6847747b85d1fa2e07859869fb9fb72c0361"), null);
    assert.equal(getContracts("eip155:14").length, 11);
    assert.equal(getContracts("eip155:19").length, 10);
    assert.equal(getContracts("eip155:114").length, 1);
    assert.throws(() => getContracts("eip155:16"), /Unknown contract chain/);

    assert.equal(getContract("eip155:14", "0x0000000000000000000000000000000000000001"), null);
    const flare = getContracts("eip155:14");
    assert.ok(flare.every((contract) => contract.chain === "eip155:14"));
    assert.ok(getContracts().length > flare.length);
    assert.throws(() => getContracts("eip155:1"), /Unknown contract chain/);
    assert.throws(() => getContracts("eip155-14"), /CAIP-2/);
  });

  test("rejects a non-lowercase address, a bad category, and a chain mismatch", () => {
    const base = {
      address: BIFROST_POOL,
      chain: "eip155:14",
      projectName: "Bifrost Wallet",
      contractName: "Collateral Pool",
      category: "collateral-pool",
    };
    assert.deepEqual(
      validateContractRecord(
        { ...base, address: "0x3A06584A47972fF7005301b5A44c7D2214A4d3b4" },
        { chainPath: "eip155-14", fileName: "0x3a06584a47972ff7005301b5a44c7d2214a4d3b4.json" },
      ).some((error) => error.includes("lowercase")),
      true,
    );
    assert.deepEqual(
      validateContractRecord(
        { ...base, category: "dex" },
        { chainPath: "eip155-14", fileName: `${BIFROST_POOL}.json` },
      ).some((error) => error.includes("category")),
      true,
    );
    assert.deepEqual(
      validateContractRecord(
        { ...base, category: "aggregator", contractName: "Aggregator" },
        { chainPath: "eip155-14", fileName: `${BIFROST_POOL}.json` },
      ),
      [],
    );
    assert.deepEqual(
      validateContractRecord(
        { ...base, chain: "eip155-14" },
        { chainPath: "eip155-14", fileName: `${BIFROST_POOL}.json` },
      ).some((error) => error.includes("CAIP-2")),
      true,
    );
    assert.deepEqual(
      validateContractRecord(
        { ...base, listed: true },
        { chainPath: "eip155-14", fileName: `${BIFROST_POOL}.json` },
      ).some((error) => error.includes("unexpected field")),
      true,
    );
  });

  test("logoURL must be an existing WebP that meets catalog size rules", () => {
    const logoDir = path.join(
      process.cwd(),
      "data",
      "contracts",
      "eip155-14",
      "0x0000000000000000000000000000000000000001",
    );
    fs.mkdirSync(logoDir, { recursive: true });
    const logoURL = "contracts/eip155-14/0x0000000000000000000000000000000000000001/logo.webp";
    const logoPath = path.join(process.cwd(), "data", logoURL);
    const entry = {
      address: BIFROST_POOL,
      chain: "eip155:14",
      projectName: "Bifrost Wallet",
      contractName: "Collateral Pool",
      category: "collateral-pool",
      logoURL,
    };
    const ctx = { chainPath: "eip155-14", fileName: `${BIFROST_POOL}.json` };
    try {
      fs.writeFileSync(logoPath, Buffer.from("not-webp"));
      assert.ok(validateContractRecord(entry, ctx).some((error) => error.includes("WebP")));

      fs.writeFileSync(logoPath, webpWithDimensions(1, 1));
      assert.ok(
        validateContractRecord(entry, ctx).some((error) => error.includes("minimum required")),
      );

      fs.writeFileSync(logoPath, webpWithDimensions(128, 128));
      assert.deepEqual(validateContractRecord(entry, ctx), []);
    } finally {
      fs.rmSync(logoDir, { recursive: true, force: true });
    }
  });
});

describe("published package contract lookups", { concurrency: false }, () => {
  test("getContract and getContracts match the catalog", () => {
    buildPackage();
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const assets = require(path.join(process.cwd(), "dist/index.js")) as {
      getContract: (chainId: string, address: string) => ContractInfo | null;
      getContracts: (chainId?: string) => ContractInfo[];
      CONTRACT_CHAIN_IDS: string[];
    };
    const fromPackage = assets.getContract(
      "eip155:14",
      "0x3A06584A47972fF7005301b5A44c7D2214A4d3b4",
    );
    const fromCatalog = getContract("eip155:14", BIFROST_POOL);
    assert.ok(fromPackage?.logoURL);
    assert.ok(fromCatalog?.logoURL);
    assert.equal(fromPackage.logoURL, resolveAssetURL(fromCatalog.logoURL));
    const { logoURL: _packageLogo, ...packageRest } = fromPackage;
    const { logoURL: _catalogLogo, ...catalogRest } = fromCatalog;
    assert.deepEqual(packageRest, catalogRest);
    assert.equal(assets.getContracts().length, getContracts().length);
    assert.ok(assets.CONTRACT_CHAIN_IDS.includes("eip155:14"));
    assert.equal(
      assets.getContract("eip155:19", "0x0000000000000000000000000000000000000001"),
      null,
    );
    assert.throws(() => assets.getContracts("not-a-chain"));
  });
});

/** Minimal VP8L WebP whose dimension parser reports width × height. */
function webpWithDimensions(width: number, height: number): Buffer {
  const bits = (width - 1) | ((height - 1) << 14);
  const chunk = Buffer.alloc(5);
  chunk[0] = 0x2f;
  chunk.writeUInt32LE(bits, 1);
  const riffSize = 4 + 8 + chunk.length;
  const out = Buffer.alloc(8 + riffSize);
  out.write("RIFF", 0);
  out.writeUInt32LE(riffSize, 4);
  out.write("WEBP", 8);
  out.write("VP8L", 12);
  out.writeUInt32LE(chunk.length, 16);
  chunk.copy(out, 20);
  return out;
}
