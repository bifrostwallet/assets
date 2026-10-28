import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { syncContractLogosFromDapps, validateContractCatalog } from "../src/contracts.js";

const BIFROST_POOL = "0x3a06584a47972ff7005301b5a44c7d2214a4d3b4";

/**
 * check:dapps reads data/contracts while the suite runs. These cases mutate a
 * private copy so a parallel reader cannot observe a drifted logoHash.
 */
function withIsolatedCatalog(run: () => void): void {
  const previous = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "contract-catalog-"));
  fs.mkdirSync(path.join(temp, "data"));
  fs.cpSync(path.join(previous, "data", "contracts"), path.join(temp, "data", "contracts"), {
    recursive: true,
  });
  fs.cpSync(path.join(previous, "data", "dapps"), path.join(temp, "data", "dapps"), {
    recursive: true,
  });
  try {
    process.chdir(temp);
    run();
  } finally {
    process.chdir(previous);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

describe("contract catalog mutations", () => {
  test("rejects a contract all.json aggregate", () => {
    withIsolatedCatalog(() => {
      const allPath = path.join(process.cwd(), "data", "contracts", "eip155-14", "all.json");
      fs.writeFileSync(allPath, "[]\n");
      const errors = validateContractCatalog();
      assert.equal(
        errors.some((error) => error.includes("do not use an aggregate file")),
        true,
      );
    });
  });

  test("syncContractLogosFromDapps rewrites a drifted logo copy", () => {
    withIsolatedCatalog(() => {
      const filePath = path.join(
        process.cwd(),
        "data",
        "contracts",
        "eip155-14",
        `${BIFROST_POOL}.json`,
      );
      const original = fs.readFileSync(filePath, "utf8");
      const record = JSON.parse(original) as { logoHash: string };
      record.logoHash = "a".repeat(64);
      fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
      assert.equal(syncContractLogosFromDapps() > 0, true);
      const restored = JSON.parse(fs.readFileSync(filePath, "utf8")) as { logoHash: string };
      assert.equal(restored.logoHash, JSON.parse(original).logoHash);
      assert.deepEqual(validateContractCatalog(), []);
    });
  });
});
