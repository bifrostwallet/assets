import path from "node:path";
import { findProviderDirs, verifyProviderSignatures } from "../verify.js";

// CLI report of provider ownership signature status across the repository.
// The requirement is a valid SELF-signature; attestations from qualifying
// attesters (listed, self-signed providers on the same chain) are reported as
// additional confirmation. With --strict, exit code 1 when any provider lacks
// a valid self-signature.

async function main(): Promise<void> {
  const strict = process.argv.includes("--strict");
  const providerDirs = findProviderDirs();

  let selfSigned = 0;
  let attestedOnly = 0;
  let missing = 0;
  let invalidOnly = 0;

  for (const providerDir of providerDirs) {
    const relativePath = path.relative(process.cwd(), providerDir);
    const result = await verifyProviderSignatures(providerDir);

    if (result.hasValidSelfSignature) {
      selfSigned++;
      console.info(`✅ ${relativePath} (self-signed)`);
      continue;
    }

    if (result.hasValidAttestation) {
      attestedOnly++;
      console.warn(`❌ ${relativePath}: attested but missing the required self-signature`);
      continue;
    }

    if (result.hasSignaturesFile) {
      invalidOnly++;
      console.warn(`❌ ${relativePath}: no valid signature for current info.json`);
      for (const invalid of result.invalidSignatures) {
        console.warn(`     ${invalid.entry.signerAddress}: ${invalid.reason}`);
      }
    } else {
      missing++;
      console.warn(`❌ ${relativePath}: signatures.json missing`);
    }
  }

  console.info(
    `\nSummary: ${selfSigned} self-signed, ${attestedOnly} attested-only, ${invalidOnly} stale/invalid, ${missing} missing (of ${providerDirs.length})`,
  );

  if (strict && selfSigned !== providerDirs.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("❌ Verification failed:", error);
  process.exitCode = 1;
});
