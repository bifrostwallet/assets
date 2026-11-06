import path from "node:path";
import { findProviderDirs, verifyProviderSignatures } from "../verify.js";

// CLI report of provider ownership signatures.
// A signature that is present must be valid. Unsigned providers, including a
// signatures file with no entries, and attested-only providers are warnings.
// Exit code 1 when any signature entry is invalid.

async function main(): Promise<void> {
  const providerDirs = findProviderDirs();

  let selfSigned = 0;
  let unsigned = 0;
  let invalid = 0;

  for (const providerDir of providerDirs) {
    const relativePath = path.relative(process.cwd(), providerDir);
    const result = await verifyProviderSignatures(providerDir);

    if (result.invalidSignatures.length > 0) {
      invalid++;
      console.error(`❌ ${relativePath}: invalid signature`);
      for (const entry of result.invalidSignatures) {
        console.error(`     ${entry.entry.signerAddress}: ${entry.reason}`);
      }
      continue;
    }

    if (result.hasValidSelfSignature) {
      selfSigned++;
      console.info(`✅ ${relativePath} (self-signed)`);
      continue;
    }

    unsigned++;
    if (result.hasValidAttestation) {
      console.warn(`⚠️ ${relativePath}: attested but missing a self-signature`);
      continue;
    }
    console.warn(`⚠️ ${relativePath}: unsigned`);
  }

  console.info(
    `\nSummary: ${selfSigned} self-signed, ${unsigned} unsigned, ${invalid} invalid (of ${providerDirs.length})`,
  );

  if (invalid > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("❌ Verification failed:", error);
  process.exitCode = 1;
});
