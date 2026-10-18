import { syncContractLogosFromDapps, validateContractCatalog } from "../contracts.js";
import { isMain } from "../isMain.js";

/**
 * Fail the process when data/contracts does not match the contract schema.
 * Unlike check:tokens, this is a hard gate: names are shown in transaction review.
 *
 * `./yarn check:contracts -- --fix` rewrites each contract's logoURL and logoHash
 * from its dapp before validating, so copies cannot drift.
 */
function checkContracts(): void {
  if (process.argv.includes("--fix")) {
    const changed = syncContractLogosFromDapps();
    console.info(`✅ Synced logo copies on ${changed} contract(s)`);
  }
  const errors = validateContractCatalog();
  if (errors.length > 0) {
    console.error(`❌ Contract catalog invalid (${errors.length}):`);
    for (const error of errors) {
      console.error(`  ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.info("✅ Contract catalog valid");
}

if (isMain(import.meta.url)) {
  checkContracts();
}

export default checkContracts;
