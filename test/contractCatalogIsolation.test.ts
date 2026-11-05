import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";
import { getContract, validateContractCatalog } from "../src/contracts.js";

const BIFROST_POOL = "0x3a06584a47972ff7005301b5a44c7d2214a4d3b4";
const BIFROST_PROJECT = "bifrostwallet-com";

/**
 * These cases mutate a private copy of data/contracts. Dapps are not copied:
 * contract logos resolve from the project folder.
 */
function withIsolatedCatalog(run: () => void): void {
  const previous = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "contract-catalog-"));
  fs.mkdirSync(path.join(temp, "data"));
  fs.cpSync(path.join(previous, "data", "contracts"), path.join(temp, "data", "contracts"), {
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

  test("rejects a logo copy stored on the contract JSON", () => {
    withIsolatedCatalog(() => {
      const filePath = path.join(
        process.cwd(),
        "data",
        "contracts",
        "eip155-14",
        `${BIFROST_POOL}.json`,
      );
      const record = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
      record.logoURL = `contracts/projects/${BIFROST_PROJECT}/logo.webp`;
      fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
      const errors = validateContractCatalog();
      assert.equal(
        errors.some((error) => error.includes("logoURL must not be stored")),
        true,
      );
    });
  });

  test("own logo.webp wins over the project logo", () => {
    withIsolatedCatalog(() => {
      const ownDir = path.join(process.cwd(), "data", "contracts", "eip155-14", BIFROST_POOL);
      fs.mkdirSync(ownDir);
      fs.copyFileSync(
        path.join(process.cwd(), "data", "contracts", "projects", BIFROST_PROJECT, "logo.webp"),
        path.join(ownDir, "logo.webp"),
      );
      const contract = getContract("eip155:14", BIFROST_POOL);
      assert.ok(contract);
      assert.equal(contract.project, BIFROST_PROJECT);
      assert.equal(contract.projectName, "Bifrost Wallet");
      assert.equal(contract.logoURL, `contracts/eip155-14/${BIFROST_POOL}/logo.webp`);
      assert.equal(
        contract.logoHash,
        createHash("sha256")
          .update(fs.readFileSync(path.join(ownDir, "logo.webp")))
          .digest("hex"),
      );
      assert.deepEqual(validateContractCatalog(), []);
      const source = JSON.parse(
        fs.readFileSync(path.join(ownDir, "..", `${BIFROST_POOL}.json`), "utf8"),
      ) as Record<string, unknown>;
      assert.equal(Object.hasOwn(source, "logoURL"), false);
      assert.equal(source.project, BIFROST_PROJECT);
    });
  });
});
