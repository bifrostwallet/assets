import { syncContractLogosFromDapps, validateContractCatalog } from "../contracts.js";
import { validateDappCategories } from "../dappCategories.js";
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
  const contractErrors = validateContractCatalog();
  const categoryErrors = validateDappCategories();
  if (contractErrors.length > 0) {
    console.error(`❌ Contract catalog invalid (${contractErrors.length}):`);
    for (const error of contractErrors) {
      console.error(`  ${error}`);
    }
  }
  if (categoryErrors.length > 0) {
    console.error(`❌ Dapp categories invalid (${categoryErrors.length}):`);
    for (const error of categoryErrors) {
      console.error(`  ${error}`);
    }
  }
  if (contractErrors.length > 0 || categoryErrors.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.info("✅ Contract catalog valid");
  console.info("✅ Dapp categories valid");
}

if (isMain(import.meta.url)) {
  checkContracts();
}

export default checkContracts;
