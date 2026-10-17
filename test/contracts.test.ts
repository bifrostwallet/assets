import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { describe, test } from "node:test";
import {
  CONTRACT_CATEGORIES,
  type ContractInfo,
  getContract,
  getContracts,
  validateContractCatalog,
  validateContractRecord,
} from "../src/contracts.js";
import buildPackage from "../src/script/packageBuild.js";

const AMAGI_V2 = "0x5ed8551f90acc6395810d8274b019bf13ef1f696";

describe("contract catalog", { concurrency: false }, () => {
  test("data/contracts matches the schema and all.json aggregates", () => {
    const errors = validateContractCatalog();
    assert.deepEqual(errors, [], errors.join("\n"));
  });

  test("seed covers aggregators, pools, vaults, and Firelight", () => {
    const all = getContracts();
    const count = (category: ContractInfo["category"]) =>
      all.filter((contract) => contract.category === category).length;
    assert.equal(count("aggregator"), 10);
    assert.equal(count("collateral-pool"), 10);
    assert.equal(count("agent-vault"), 10);
    assert.equal(count("staking-protocol"), 2);
    assert.equal(all.length, 32);
    assert.ok(CONTRACT_CATEGORIES.includes("router"));
    assert.ok(CONTRACT_CATEGORIES.includes("bridge"));
    assert.ok(CONTRACT_CATEGORIES.includes("dapp-contract"));
  });

  test("getContract is case-insensitive and getContracts filters by CAIP-2", () => {
    const lower = getContract("eip155:14", AMAGI_V2);
    const checksum = getContract("eip155:14", "0x5ED8551F90aCC6395810d8274b019bf13EF1f696");
    assert.ok(lower);
    assert.deepEqual(checksum, lower);
    assert.equal(lower.projectName, "AmagiSwap");
    assert.equal(lower.contractName, "Aggregator V2");
    assert.equal(lower.category, "aggregator");
    assert.equal(lower.chain, "eip155:14");
    assert.equal("logoURL" in lower, false);

    assert.equal(getContract("eip155:14", "0x0000000000000000000000000000000000000001"), null);
    const flare = getContracts("eip155:14");
    assert.ok(flare.every((contract) => contract.chain === "eip155:14"));
    assert.ok(getContracts().length > flare.length);
    assert.throws(() => getContracts("eip155:1"), /Unknown contract chain/);
    assert.throws(() => getContracts("eip155-14"), /CAIP-2/);
  });

  test("rejects a non-lowercase address, a bad category, and a chain mismatch", () => {
    const base = {
      address: "0x5ed8551f90acc6395810d8274b019bf13ef1f696",
      chain: "eip155:14",
      projectName: "AmagiSwap",
      contractName: "Aggregator V2",
      category: "aggregator",
    };
    assert.deepEqual(
      validateContractRecord(
        { ...base, address: "0x5ED8551F90aCC6395810d8274b019bf13EF1f696" },
        { chainPath: "eip155-14", fileName: "0x5ed8551f90acc6395810d8274b019bf13ef1f696.json" },
      ).some((error) => error.includes("lowercase")),
      true,
    );
    assert.deepEqual(
      validateContractRecord(
        { ...base, category: "dex" },
        { chainPath: "eip155-14", fileName: `${AMAGI_V2}.json` },
      ).some((error) => error.includes("category")),
      true,
    );
    assert.deepEqual(
      validateContractRecord(
        { ...base, chain: "eip155-14" },
        { chainPath: "eip155-14", fileName: `${AMAGI_V2}.json` },
      ).some((error) => error.includes("CAIP-2")),
      true,
    );
    assert.deepEqual(
      validateContractRecord(
        { ...base, listed: true },
        { chainPath: "eip155-14", fileName: `${AMAGI_V2}.json` },
      ).some((error) => error.includes("unexpected field")),
      true,
    );
  });

  test("logoURL must be an existing WebP that meets catalog size rules", () => {
    const logoDir = path.join(process.cwd(), "data", "contracts", "logos");
    fs.mkdirSync(logoDir, { recursive: true });
    const logoURL = "contracts/logos/contract-logo-test.webp";
    const logoPath = path.join(process.cwd(), "data", logoURL);
    const entry = {
      address: AMAGI_V2,
      chain: "eip155:14",
      projectName: "AmagiSwap",
      contractName: "Aggregator V2",
      category: "aggregator",
      logoURL,
    };
    const ctx = { chainPath: "eip155-14", fileName: `${AMAGI_V2}.json` };
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
      fs.rmSync(logoPath, { force: true });
      if (fs.existsSync(logoDir) && fs.readdirSync(logoDir).length === 0) {
        fs.rmdirSync(logoDir);
      }
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
      "0x5ED8551F90aCC6395810d8274b019bf13EF1f696",
    );
    assert.deepEqual(fromPackage, getContract("eip155:14", AMAGI_V2));
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
