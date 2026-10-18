import { checkDappCatalog } from "../dappCheck.js";
import { isMain } from "../isMain.js";

/**
 * Fail when the dapp catalog or a contract logo copy is wrong.
 * A dapp that is in no browser chip is printed as a warning and does not fail.
 */
function checkDapps(): void {
  const { errors, warnings } = checkDappCatalog();
  for (const warning of warnings) {
    console.warn(`⚠️ ${warning}`);
  }
  if (errors.length > 0) {
    console.error(`❌ Dapp catalog invalid (${errors.length}):`);
    for (const error of errors) {
      console.error(`  ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  console.info("✅ Dapp catalog valid");
}

if (isMain(import.meta.url)) {
  checkDapps();
}

export default checkDapps;
